import { describe, expect, it } from "vitest"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import {
  createEntitlementWindowProcessorHarness,
  describeEntitlementWindowProcessorContract,
} from "./testing/processor-contract"

// Characterizes the port boundary: the processor must run against a plain
// in-memory store (no Durable Object, no SQLite/drizzle) using the real meter
// engine, real pricing, and real Zod contracts. This is the seam a future
// Redis-backed store implements.

function createHarness(
  params: { now: number; store?: InMemoryEntitlementWindowStore } = { now: Date.now() }
) {
  let invalidateEnforcementStateCache = () => {}
  const store =
    params.store ?? new InMemoryEntitlementWindowStore(() => invalidateEnforcementStateCache())
  const harness = createEntitlementWindowProcessorHarness({ now: params.now, store })
  invalidateEnforcementStateCache = () => harness.processor.invalidateEnforcementStateCache()
  return harness
}

function createLiveApplyInput(now: number, overrides: Record<string, unknown> = {}) {
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}
  return createApplyInput({
    creditLinePolicy: "uncapped",
    now,
    periodStartAt: now - 60_000,
    periodEndAt: now + 60_000,
    ...overrides,
    event: { timestamp: now, ...eventOverrides },
  })
}

describe("in-memory store internals", () => {
  it("applies, seals idempotency, and replays without recomputing", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const input = createLiveApplyInput(now, {
      idempotencyKey: "idem_port_1",
      event: { id: "evt_port_1", properties: { amount: 3 } },
    })

    const first = await harness.processor.apply(input)
    expect(first.allowed).toBe(true)
    expect(first.meterFacts).toHaveLength(1)
    expect(first.meterFacts?.[0]).toMatchObject({ delta: 3, value_after: 3 })

    const replay = await harness.processor.apply(input)
    expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
    // The replay must come from the sealed entry, not a re-run of the meter.
    expect(harness.store.meterStates.values().next().value?.usage).toBe(3)
    // A post-commit alarm was scheduled for lifecycle work.
    await Promise.all(harness.waitUntilPromises)
    expect(harness.getAlarmAt()).not.toBeNull()
  })

  it("rolls back the whole atomic command when a commit fails mid-write", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const originalWrite = harness.store.writeBatchIdempotencyResults.bind(harness.store)
    let failNext = true
    harness.store.writeBatchIdempotencyResults = (entries) => {
      if (failNext) {
        failNext = false
        throw new Error("simulated storage failure")
      }
      originalWrite(entries)
    }

    const input = createLiveApplyInput(now, {
      idempotencyKey: "idem_port_rollback",
      event: { id: "evt_port_rollback", properties: { amount: 4 } },
    })

    await expect(harness.processor.apply(input)).rejects.toThrow("simulated storage failure")
    // Nothing from the failed command may survive: no seal, no meter usage.
    expect(harness.store.idempotency.size).toBe(0)
    expect(harness.store.meterStates.size).toBe(0)

    const retried = await harness.processor.apply(input)
    expect(retried).toMatchObject({ allowed: true })
    expect(retried.idempotencyStatus).toBeUndefined()
    expect(harness.store.meterStates.values().next().value?.usage).toBe(4)
  })
})

describeEntitlementWindowProcessorContract(
  "EntitlementWindowProcessor (in-memory store contract)",
  () => new InMemoryEntitlementWindowStore()
)
