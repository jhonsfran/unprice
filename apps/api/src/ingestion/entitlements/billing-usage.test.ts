import { DO_IDEMPOTENCY_TTL_MS } from "@unprice/services/entitlements"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDeferred } from "../test-fixtures/race"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"
import { createEntitlementWindowWalletHarness } from "./testing/wallet-harness"

function createBillingHarness() {
  let now = Date.now()
  const input = createApplyInput({
    now,
    periodStartAt: now - 60_000,
    periodEndAt: now + 60_000,
    event: { timestamp: now },
  })
  const entitlement = { ...input.entitlement, subscriptionId: "sub_123" }
  const store = new InMemoryEntitlementWindowStore()
  const harness = createEntitlementWindowProcessorHarness({ now: () => now, store })
  const period = input.entitlement.billingPeriods[0]!
  const registration = {
    projectId: input.projectId,
    customerId: input.customerId,
    customerEntitlementId: entitlement.customerEntitlementId,
    subscriptionId: "sub_123",
    subscriptionPhaseId: "phase_123",
    subscriptionItemId: "item_123",
    billingPeriodId: period.billingPeriodId,
    statementKey: period.statementKey,
    featureSlug: entitlement.featureSlug,
    cycleStartAt: period.cycleStartAt,
    cycleEndAt: period.cycleEndAt,
    currency: "USD" as const,
    amountScale: 8 as const,
    origin: "period_generation_v1" as const,
    genesis: { version: 1 as const, customerEntitlementId: entitlement.customerEntitlementId },
    registeredAt: now,
  }
  return {
    ...harness,
    store,
    input: { ...input, entitlement },
    registration,
    setNow: (value: number) => {
      now = value
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe("authoritative billing usage", () => {
  it("refuses genesis proof for another entitlement on an empty object", async () => {
    const { processor, registration, store } = createBillingHarness()
    await expect(
      processor.registerBillingPeriods([
        {
          ...registration,
          genesis: { version: 1, customerEntitlementId: "ent_other" },
        },
      ])
    ).rejects.toThrow("genesis belongs to another entitlement")
    expect(store.listBillingUsageSnapshots()).toEqual([])
  })

  it("stores accepted amounts with their receipt and replays without adding them twice", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    const accepted = await processor.apply(input)
    const replayed = await processor.apply(input)
    expect(accepted.meterFacts?.map((fact) => [fact.amount, fact.delta])).toEqual([
      [100_000_000, 1],
    ])
    expect(replayed.allowed).toBe(true)
    expect(store.readBillingUsageSnapshot("bp_123")).toMatchObject({
      amount: 100_000_000,
      quantity: 1,
      state: "open",
    })
    expect(store.idempotency.size).toBe(1)
  })

  it("accumulates batch corrections as signed amounts and quantities", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    const batch = {
      projectId: input.projectId,
      customerId: input.customerId,
      entitlement: input.entitlement,
      grants: input.grants,
      enforceLimit: input.enforceLimit,
      events: [10, -4, 4].map((amount, index) => ({
        ...input.event,
        id: `event_${index}`,
        correlationKey: `key_${index}`,
        idempotencyKey: `key_${index}`,
        properties: { amount },
        now: input.now,
      })),
    }
    await processor.applyBatch(batch)
    await processor.applyBatch(batch)
    expect(store.readBillingUsageSnapshot("bp_123")).toMatchObject({
      amount: 1_000_000_000,
      quantity: 10,
    })
    expect(store.idempotency.size).toBe(3)
  })

  it("records externally reserved run usage in the same billing snapshot", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    const accepted = await processor.apply({
      ...input,
      wallet: { mode: "external_reservation", remainingAmount: 1_000_000_000 },
    })
    expect(accepted.allowed).toBe(true)
    expect(store.readBillingUsageSnapshot("bp_123")).toMatchObject({
      amount: 100_000_000,
      quantity: 1,
    })
  })

  it("keeps a seal stable, rejects fresh events, and still replays accepted events", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    await processor.apply(input)
    const first = await processor.sealBillingPeriods([registration])
    await expect(
      processor.apply({ ...input, idempotencyKey: "fresh", event: { ...input.event, id: "fresh" } })
    ).rejects.toThrow("sealed")
    const replayed = await processor.apply(input)
    const repeated = await processor.sealBillingPeriods([registration])
    expect(replayed.allowed).toBe(true)
    expect(repeated).toEqual(first)
    expect(store.readBillingUsageSnapshot("bp_123")).toMatchObject({
      amount: 100_000_000,
      quantity: 1,
      state: "sealed",
    })
    expect(store.idempotency.size).toBe(1)
  })

  it("refuses missing legacy coverage instead of assuming zero usage", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await expect(processor.apply(input)).rejects.toThrow("no complete usage registration")
    await expect(processor.sealBillingPeriods([registration])).rejects.toThrow(
      "unknown usage coverage"
    )
    expect(store.readBillingUsageSnapshot("bp_123")).toBeNull()
    expect(store.idempotency.size).toBe(0)
  })

  it("retains unfinished billing state through inactivity and deletion requests", async () => {
    const { processor, registration, setNow, wasDestroyed } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    setNow(registration.cycleEndAt + DO_IDEMPOTENCY_TTL_MS + 1)
    await processor.alarm()
    expect(wasDestroyed()).toBe(false)
    await processor.sealBillingPeriods([registration])
    await processor.requestDeletion()
    expect(wasDestroyed()).toBe(false)
    await processor.completeBillingPeriods([registration.billingPeriodId])
    await processor.alarm()
    expect(wasDestroyed()).toBe(false)
    setNow(registration.cycleEndAt + 2 * DO_IDEMPOTENCY_TTL_MS + 2)
    await processor.alarm()
    expect(wasDestroyed()).toBe(true)
  })
  it("rejects a correction that would require a credit from an earlier billing period", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    await processor.apply({ ...input, event: { ...input.event, properties: { amount: 10 } } })
    await processor.sealBillingPeriods([registration])
    const next = {
      ...registration,
      billingPeriodId: "bp_next",
      statementKey: "stmt_next",
      cycleStartAt: input.now + 1,
      cycleEndAt: registration.cycleEndAt + 60_000,
    }
    await processor.registerBillingPeriods([next])
    const correction = {
      ...input,
      idempotencyKey: "correction",
      now: input.now + 2,
      entitlement: {
        ...input.entitlement,
        billingPeriods: [{ ...next, featurePlanVersionItemId: "item_123" }],
      },
      event: {
        ...input.event,
        id: "correction",
        timestamp: input.now + 2,
        properties: { amount: -4 },
      },
    }
    const denied = await processor.apply(correction)
    expect(denied).toMatchObject({ allowed: false, deniedReason: "INVALID_AGGREGATION_PROPERTIES" })
    expect(await processor.apply(correction)).toMatchObject({
      allowed: false,
      deniedReason: "INVALID_AGGREGATION_PROPERTIES",
    })
    expect(store.readBillingUsageSnapshot("bp_next")).toMatchObject({
      amount: 0,
      quantity: 0,
      state: "open",
    })
    expect(store.idempotency.size).toBe(2)
  })

  it("denies an unsupported batch correction without changing the next accepted event", async () => {
    const { processor, input, registration, store } = createBillingHarness()
    await processor.registerBillingPeriods([registration])
    await processor.apply({ ...input, event: { ...input.event, properties: { amount: 10 } } })
    await processor.sealBillingPeriods([registration])
    const next = {
      ...registration,
      billingPeriodId: "bp_next",
      statementKey: "stmt_next",
      cycleStartAt: input.now + 1,
      cycleEndAt: registration.cycleEndAt + 60_000,
    }
    await processor.registerBillingPeriods([next])
    const batch = {
      projectId: input.projectId,
      customerId: input.customerId,
      entitlement: {
        ...input.entitlement,
        billingPeriods: [{ ...next, featurePlanVersionItemId: "item_123" }],
      },
      grants: input.grants,
      enforceLimit: input.enforceLimit,
      events: [-4, 1].map((amount, index) => ({
        ...input.event,
        id: `next_${index}`,
        correlationKey: `next_${index}`,
        idempotencyKey: `next_${index}`,
        timestamp: input.now + 2 + index,
        properties: { amount },
        now: input.now + 2 + index,
      })),
    }
    const result = await processor.applyBatch(batch)
    expect(result.results.map((event) => [event.allowed, event.deniedReason ?? null])).toEqual([
      [false, "INVALID_AGGREGATION_PROPERTIES"],
      [true, null],
    ])
    expect(result.results[1]?.meterFacts?.map((fact) => [fact.delta, fact.value_after])).toEqual([
      [1, 11],
    ])
    await processor.applyBatch(batch)
    expect(store.readBillingUsageSnapshot("bp_next")).toMatchObject({
      amount: 100_000_000,
      quantity: 1,
    })
    expect(store.idempotency.size).toBe(3)
  })

  it("rejects an in-flight accepted draft when sealing happens during wallet I/O", async () => {
    const { input, registration, store } = createBillingHarness()
    const wallet = createEntitlementWindowWalletHarness()
    const entered = createDeferred<void>()
    const release = createDeferred<void>()
    const create = wallet.createReservation.getMockImplementation()!
    wallet.createReservation.mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return create(...args)
    })
    const harness = createEntitlementWindowProcessorHarness({
      now: input.now,
      store,
      wallet: wallet.provider,
    })
    await harness.processor.registerBillingPeriods([registration])
    const applying = harness.processor.apply({
      ...input,
      entitlement: { ...input.entitlement, creditLinePolicy: "capped" },
    })
    const rejected = expect(applying).rejects.toThrow("sealed")
    await entered.promise
    await harness.processor.sealBillingPeriods([registration])
    release.resolve()
    await rejected
    expect(store.readBillingUsageSnapshot("bp_123")).toMatchObject({
      amount: 0,
      quantity: 0,
      state: "sealed",
    })
    expect(store.idempotency.size).toBe(0)
  })

  it("retains completed capped receipts during manual deletion until replay expiry", async () => {
    const { input, registration, store } = createBillingHarness()
    let now = input.now
    const wallet = createEntitlementWindowWalletHarness()
    const harness = createEntitlementWindowProcessorHarness({
      now: () => now,
      store,
      wallet: wallet.provider,
    })
    await harness.processor.registerBillingPeriods([registration])
    expect(
      (
        await harness.processor.apply({
          ...input,
          entitlement: { ...input.entitlement, creditLinePolicy: "capped" },
        })
      ).allowed
    ).toBe(true)
    await Promise.all(harness.waitUntilPromises)
    now += 100
    await harness.processor.sealBillingPeriods([registration])
    await harness.processor.completeBillingPeriods([registration.billingPeriodId])
    await harness.processor.requestDeletion()
    await harness.processor.alarm()
    expect(harness.wasDestroyed()).toBe(false)
    expect((await harness.processor.apply(input)).allowed).toBe(true)
    now = registration.cycleEndAt + DO_IDEMPOTENCY_TTL_MS + 2
    await harness.processor.alarm()
    expect(harness.wasDestroyed()).toBe(true)
  })
})
