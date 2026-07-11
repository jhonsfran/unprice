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
  "apply" | "getEnforcementState"
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
  let alarmAt: number | null = null
  let destroyed = false

  const deps: EntitlementWindowProcessorDeps = {
    clock: { now: () => (typeof params.now === "function" ? params.now() : params.now) },
    instrument: (_operation, fn) => fn(),
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

/** Runs the full portable processor contract against one persistent host. */
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
  })
}
