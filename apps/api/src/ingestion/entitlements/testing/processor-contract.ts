import type { Logger } from "@unprice/logs"
import { describe, expect, it } from "vitest"
import { applyInputSchema } from "../contracts"
import { createApplyInput } from "../entitlement-window-test-fixtures"
import type {
  EntitlementWindowProcessorDeps,
  EntitlementWindowStateStore,
  EntitlementWindowTimingConfig,
  EntitlementWindowWalletProvider,
} from "../ports"
import { EntitlementWindowProcessor } from "../processor"

export type EntitlementWindowStoreFactory<
  TStore extends EntitlementWindowStateStore = EntitlementWindowStateStore,
> = () => TStore

export type EntitlementWindowProcessorContractTarget = Pick<
  EntitlementWindowProcessor,
  "apply" | "applyBatch" | "getEnforcementState"
>

export type EntitlementWindowProcessorContractHost = {
  target: EntitlementWindowProcessorContractTarget
  revive():
    | EntitlementWindowProcessorContractTarget
    | Promise<EntitlementWindowProcessorContractTarget>
}

export type EntitlementWindowProcessorContractHostFactory = () =>
  | EntitlementWindowProcessorContractHost
  | Promise<EntitlementWindowProcessorContractHost>

function createNoopLogger(): Logger {
  return {
    set: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
  }
}

export function createEntitlementWindowProcessorHarness<
  TStore extends EntitlementWindowStateStore,
>(params: {
  now: number | (() => number)
  store: TStore
  timing?: Partial<EntitlementWindowTimingConfig>
  wallet?: EntitlementWindowWalletProvider
}) {
  const waitUntilPromises: Promise<unknown>[] = []
  const instrumentationCalls: Array<{
    baseFields?: Record<string, unknown>
    operation: string
  }> = []
  let alarmAt: number | null = null
  let destroyed = false

  const deps: EntitlementWindowProcessorDeps = {
    clock: { now: () => (typeof params.now === "function" ? params.now() : params.now) },
    instrument: (operation, fn, baseFields) => {
      instrumentationCalls.push({
        operation,
        ...(baseFields ? { baseFields: { ...baseFields } } : {}),
      })
      return fn()
    },
    logger: createNoopLogger(),
    runtime: {
      instanceId: "window_test_1",
      waitUntil: (promise) => {
        waitUntilPromises.push(promise)
      },
      destroyWindow: async () => {
        destroyed = true
        alarmAt = null
      },
    },
    scheduler: {
      getAlarm: async () => alarmAt,
      setAlarm: async (at) => {
        alarmAt = at
      },
      deleteAlarm: async () => {
        alarmAt = null
      },
    },
    store: params.store,
    timing: {
      inactivityThresholdMs: 60 * 60 * 1000,
      maxFlushIntervalMs: 10 * 60_000,
      ...params.timing,
    },
    wallet:
      params.wallet ??
      ({
        get: () => {
          throw new Error("wallet must not be constructed for uncapped entitlements")
        },
      } satisfies EntitlementWindowWalletProvider),
  }

  return {
    instrumentationCalls,
    processor: new EntitlementWindowProcessor(deps),
    store: params.store,
    waitUntilPromises,
    getAlarmAt: () => alarmAt,
    wasDestroyed: () => destroyed,
  }
}

function createLiveApplyInput(now: number, overrides: Record<string, unknown> = {}) {
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}
  return applyInputSchema.parse(
    createApplyInput({
      creditLinePolicy: "uncapped",
      now,
      periodStartAt: now - 60_000,
      periodEndAt: now + 60_000,
      ...overrides,
      event: { timestamp: now, ...eventOverrides },
    })
  )
}

function createLiveApplyBatchInput(params: {
  amounts: number[]
  idPrefix: string
  now: number
  overrides?: Record<string, unknown>
}) {
  const base = createLiveApplyInput(params.now, params.overrides)
  return {
    customerId: base.customerId,
    entitlement: base.entitlement,
    enforceLimit: base.enforceLimit,
    events: params.amounts.map((amount, index) => ({
      ...base.event,
      correlationKey: `${params.idPrefix}_${index}`,
      id: `evt_${params.idPrefix}_${index}`,
      idempotencyKey: `idem_${params.idPrefix}_${index}`,
      now: params.now + index,
      properties: { amount },
      timestamp: params.now + index,
    })),
    grants: base.grants,
    projectId: base.projectId,
  }
}

/**
 * Runs the portable processor/store contract against a backend factory.
 *
 * A future store backend imports this runner from its own test file and passes
 * a fresh store factory. These cases only observe the processor's public API;
 * in-memory-map assertions remain in processor.test.ts.
 */
export function createEntitlementWindowStoreContractHostFactory<
  TStore extends EntitlementWindowStateStore,
>(makeStore: EntitlementWindowStoreFactory<TStore>): EntitlementWindowProcessorContractHostFactory {
  return async () => {
    const store = makeStore()
    const createTarget = async () => {
      const harness = createEntitlementWindowProcessorHarness({ now: Date.now(), store })
      await harness.processor.initialize()
      return harness.processor
    }

    return {
      target: await createTarget(),
      revive: createTarget,
    }
  }
}

/** Runs the portable apply/applyBatch/enforcement contract against one persistent host. */
export function describeEntitlementWindowProcessorContract(
  suiteName: string,
  makeHost: EntitlementWindowProcessorContractHostFactory
): void {
  describe(suiteName, () => {
    it("enforces hard limits and seals the denial for stable retries", async () => {
      const now = Date.now()
      const { target } = await makeHost()
      const input = createLiveApplyInput(now, {
        enforceLimit: true,
        limit: 2,
        idempotencyKey: "idem_port_denied",
        event: { id: "evt_port_denied", properties: { amount: 3 } },
      })

      const denied = await target.apply(input)
      expect(denied).toMatchObject({ allowed: false, deniedReason: "LIMIT_EXCEEDED" })

      const replay = await target.apply(input)
      expect(replay).toMatchObject({
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        idempotencyStatus: "already_reported",
      })
      expect(
        await target.getEnforcementState({
          entitlement: input.entitlement,
          grants: input.grants,
          now,
        })
      ).toMatchObject({ usage: 0, limit: 2, isLimitReached: false })
    })

    it("keeps committed state visible after reviving a fresh host", async () => {
      const now = Date.now()
      const host = await makeHost()

      const input = createLiveApplyInput(now, {
        idempotencyKey: "idem_port_evict",
        event: { id: "evt_port_evict", properties: { amount: 5 } },
      })
      await host.target.apply(input)

      const revived = await host.revive()

      const replay = await revived.apply(input)
      expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
      await expect(
        revived.getEnforcementState({
          entitlement: input.entitlement,
          grants: input.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 5 })
    })

    it("commits mixed batch outcomes and deduplicates repeated keys atomically", async () => {
      const now = Date.now()
      const host = await makeHost()
      const input = createLiveApplyBatchInput({
        amounts: [2, 2, 1],
        idPrefix: "port_mixed_batch",
        now,
        overrides: { enforceLimit: true, limit: 3 },
      })
      input.events[2]!.idempotencyKey = input.events[0]!.idempotencyKey

      const result = await host.target.applyBatch(input)

      expect(
        result.results.map(({ allowed, deniedReason, idempotencyStatus }) => ({
          allowed,
          deniedReason,
          idempotencyStatus,
        }))
      ).toEqual([
        { allowed: true, deniedReason: undefined, idempotencyStatus: undefined },
        {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          idempotencyStatus: undefined,
        },
        { allowed: true, deniedReason: undefined, idempotencyStatus: "already_reported" },
      ])
      expect(result.results[0]?.meterFacts).toHaveLength(1)
      expect(result.results[1]?.meterFacts).toBeUndefined()
      expect(result.results[2]?.meterFacts).toEqual(result.results[0]?.meterFacts)
      await expect(
        host.target.getEnforcementState({
          entitlement: input.entitlement,
          grants: input.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 2, limit: 3 })

      const revived = await host.revive()
      const replay = await revived.applyBatch(input)
      expect(
        replay.results.map(({ allowed, deniedReason, idempotencyStatus }) => ({
          allowed,
          deniedReason,
          idempotencyStatus,
        }))
      ).toEqual([
        { allowed: true, deniedReason: undefined, idempotencyStatus: "already_reported" },
        {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          idempotencyStatus: "already_reported",
        },
        { allowed: true, deniedReason: undefined, idempotencyStatus: "already_reported" },
      ])
      expect(replay.results[2]?.meterFacts).toEqual(replay.results[0]?.meterFacts)
      await expect(
        revived.getEnforcementState({
          entitlement: input.entitlement,
          grants: input.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 2, limit: 3 })
    })

    it("replays a committed batch after reviving a fresh host without double metering", async () => {
      const now = Date.now()
      const host = await makeHost()
      const input = createLiveApplyBatchInput({
        amounts: [2, 3],
        idPrefix: "port_replay_batch",
        now,
      })

      const original = await host.target.applyBatch(input)
      const revived = await host.revive()
      const replay = await revived.applyBatch(input)

      expect(replay.results).toEqual(
        original.results.map((result) => ({
          ...result,
          idempotencyStatus: "already_reported" as const,
        }))
      )
      await expect(
        revived.getEnforcementState({
          entitlement: input.entitlement,
          grants: input.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 5 })
    })
  })
}
