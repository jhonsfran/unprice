import { evictDurableObject, reset, runDurableObjectAlarm } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { buildIngestionWindowName } from "@unprice/services/ingestion"
import { afterEach, describe, expect, it } from "vitest"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { describeEntitlementWindowProcessorBehaviorContract } from "./testing/processor-contract"

const WORKERS_NOW = Date.now()

function entitlementStub(params: {
  customerEntitlementId?: string
  customerId?: string
  projectId?: string
}) {
  return env.entitlementwindow.getByName(
    buildIngestionWindowName({
      appEnv: "test",
      customerEntitlementId: params.customerEntitlementId ?? "ce_123",
      customerId: params.customerId ?? "cus_123",
      projectId: params.projectId ?? "proj_123",
    })
  )
}

function createWorkersApplyInput(overrides: Record<string, unknown> = {}) {
  const now = typeof overrides.now === "number" ? overrides.now : WORKERS_NOW
  const periodStartAt =
    typeof overrides.periodStartAt === "number" ? overrides.periodStartAt : now - 60_000
  const periodEndAt =
    typeof overrides.periodEndAt === "number" ? overrides.periodEndAt : now + 60_000
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}

  // The real workers runtime validates event timestamps against Date.now().
  // Keep the shared fixture deterministic, but use a live test-local window here.
  return createApplyInput({
    ...overrides,
    now,
    periodStartAt,
    periodEndAt,
    event: {
      ...eventOverrides,
      timestamp: typeof eventOverrides.timestamp === "number" ? eventOverrides.timestamp : now,
    },
  })
}

afterEach(async () => {
  await reset()
})

describeEntitlementWindowProcessorBehaviorContract(
  "EntitlementWindowProcessor (Durable Object SQLite contract)",
  () => entitlementStub({})
)

describe("EntitlementWindowDO workers runtime invariants", () => {
  it("lazy-resets entitlement usage when the reset period changes", async () => {
    const now = Date.now()
    const currentDate = new Date(now)
    const currentDayStart = Date.UTC(
      currentDate.getUTCFullYear(),
      currentDate.getUTCMonth(),
      currentDate.getUTCDate()
    )
    const previousDayStart = currentDayStart - 24 * 60 * 60 * 1000
    const nextDayStart = currentDayStart + 24 * 60 * 60 * 1000
    const previousEventAt = currentDayStart - 1
    const currentEventAt = Math.max(currentDayStart, now - 1_000)
    const stub = entitlementStub({ customerEntitlementId: "ce_lazy_reset" })
    const baseInput = createWorkersApplyInput({
      creditLinePolicy: "uncapped",
      customerEntitlementId: "ce_lazy_reset",
      enforceLimit: true,
      limit: 2,
      now: previousEventAt,
      periodStartAt: previousDayStart,
      periodEndAt: nextDayStart,
      resetConfig: {
        name: "daily",
        planType: "recurring",
        resetAnchor: 1,
        resetInterval: "day",
        resetIntervalCount: 1,
      },
    })

    const previousPeriod = await stub.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_lazy_reset_previous",
        properties: { amount: 2 },
        timestamp: previousEventAt,
      },
      idempotencyKey: "idem_lazy_reset_previous",
      now: previousEventAt,
    })
    const currentPeriod = await stub.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_lazy_reset_current",
        properties: { amount: 1 },
        timestamp: currentEventAt,
      },
      idempotencyKey: "idem_lazy_reset_current",
      now: currentEventAt,
    })

    expect(previousPeriod).toMatchObject({ allowed: true })
    expect(currentPeriod).toMatchObject({ allowed: true })
    expect(previousPeriod.meterFacts?.[0]?.period_key).toBe(`day:${previousDayStart}`)
    expect(currentPeriod.meterFacts?.[0]?.period_key).toBe(`day:${currentDayStart}`)
    await expect(
      stub.getEnforcementState({
        entitlement: baseInput.entitlement,
        grants: baseInput.grants,
        now: currentEventAt,
      })
    ).resolves.toMatchObject({ isLimitReached: false, limit: 2, usage: 1 })
  })

  it("preserves persisted state across eviction and alarm execution", async () => {
    const stub = entitlementStub({ customerEntitlementId: "ce_alarm" })
    const input = createWorkersApplyInput({
      customerEntitlementId: "ce_alarm",
      idempotencyKey: "idem_alarm",
      event: { id: "evt_alarm", properties: { amount: 2 } },
    })

    await expect(stub.apply(input)).resolves.toMatchObject({ allowed: true })
    await evictDurableObject(stub)
    const revived = entitlementStub({ customerEntitlementId: "ce_alarm" })

    await expect(
      revived.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now: input.now,
      })
    ).resolves.toMatchObject({ usage: 2 })

    await expect(runDurableObjectAlarm(revived)).resolves.toBe(true)
  })

  it("partitions concurrent hard-limit writes without over-consuming", async () => {
    const stub = entitlementStub({})
    const inputs = Array.from({ length: 5 }, (_unused, index) =>
      createWorkersApplyInput({
        enforceLimit: true,
        limit: 5,
        idempotencyKey: `idem_hard_limit_${index}`,
        event: {
          id: `evt_hard_limit_${index}`,
          properties: { amount: 2 },
        },
      })
    )

    const results = await Promise.all(inputs.map((input) => stub.apply(input)))
    const accepted = results.filter((result) => result.allowed)
    const rejected = results.filter((result) => !result.allowed)

    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(3)
    expect(rejected.map((result) => result.deniedReason)).toEqual([
      "LIMIT_EXCEEDED",
      "LIMIT_EXCEEDED",
      "LIMIT_EXCEEDED",
    ])

    const state = await stub.getEnforcementState({
      entitlement: inputs[0]!.entitlement,
      grants: inputs[0]!.grants,
      now: inputs[0]!.now,
    })
    expect(state.usage).toBe(4)
    expect(state.limit).toBe(5)
    expect(state.isLimitReached).toBe(false)

    await evictDurableObject(stub)
  })

  it("keeps sibling entitlement windows isolated under concurrent writes", async () => {
    const first = entitlementStub({ customerEntitlementId: "ce_first" })
    const second = entitlementStub({ customerEntitlementId: "ce_second" })
    const firstInput = createWorkersApplyInput({
      customerEntitlementId: "ce_first",
      idempotencyKey: "idem_first",
      event: { id: "evt_first", properties: { amount: 3 } },
    })
    const secondInput = createWorkersApplyInput({
      customerEntitlementId: "ce_second",
      idempotencyKey: "idem_second",
      event: { id: "evt_second", properties: { amount: 7 } },
    })

    await Promise.all([first.apply(firstInput), second.apply(secondInput)])

    await expect(
      first.getEnforcementState({
        entitlement: firstInput.entitlement,
        grants: firstInput.grants,
        now: firstInput.now,
      })
    ).resolves.toMatchObject({ usage: 3 })
    await expect(
      second.getEnforcementState({
        entitlement: secondInput.entitlement,
        grants: secondInput.grants,
        now: secondInput.now,
      })
    ).resolves.toMatchObject({ usage: 7 })

    await evictDurableObject(first)
  })
})
