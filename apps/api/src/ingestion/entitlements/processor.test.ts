import { DO_IDEMPOTENCY_TTL_MS, LATE_EVENT_GRACE_MS } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import { createDeferred } from "../test-fixtures/race"
import type { ApplyInput } from "./contracts"
import type { WalletReservationSnapshot } from "./contracts"
import {
  createApplyInput as createFixtureApplyInput,
  createGrantSnapshot as createFixtureGrantSnapshot,
} from "./entitlement-window-test-fixtures"
import type { EntitlementWindowWalletOps } from "./ports"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import {
  createEntitlementWindowProcessorHarness,
  createEntitlementWindowStoreContractHostFactory,
  describeEntitlementWindowProcessorContract,
} from "./testing/processor-contract"

// Characterizes the port boundary: the processor must run against a plain
// in-memory store (no Durable Object, no SQLite/drizzle) using the real meter
// engine, real pricing, and real Zod contracts. This is the seam a future
// Redis-backed store implements.

const BASE_NOW = Date.now()

function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
  return createFixtureGrantSnapshot({
    cadenceEffectiveAt: BASE_NOW - 60_000,
    cadenceExpiresAt: BASE_NOW + 60_000,
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: BASE_NOW + 60_000,
    ...overrides,
  })
}

function createApplyInput(overrides: Record<string, unknown> = {}) {
  const now = typeof overrides.now === "number" ? overrides.now : BASE_NOW
  const event = (overrides.event as Record<string, unknown> | undefined) ?? {}
  return createFixtureApplyInput({
    periodStartAt: now - 60_000,
    periodEndAt: now + 60_000,
    ...overrides,
    event: { timestamp: now, ...event },
  })
}

function createHarness(
  params: Parameters<
    typeof createEntitlementWindowProcessorHarness<InMemoryEntitlementWindowStore>
  >[0]
) {
  let invalidateEnforcementStateCache = () => {}
  const store =
    params.store ?? new InMemoryEntitlementWindowStore(() => invalidateEnforcementStateCache())
  const harness = createEntitlementWindowProcessorHarness({ ...params, store })
  invalidateEnforcementStateCache = () => harness.processor.invalidateEnforcementStateCache()
  return harness
}

function createWalletHarness(
  overrides: Partial<{
    allocationAmount: number
    captureError: Error
    createError: Error
    extendAmount: number
    extendError: Error
    releaseError: Error
  }> = {}
) {
  const createReservation = vi.fn(async () =>
    overrides.createError
      ? { err: overrides.createError, val: null }
      : {
          err: null,
          val: {
            reservationId: "res_test",
            allocationAmount: overrides.allocationAmount ?? 1_000_000_000,
          },
        }
  )
  const captureReservationUsage = vi.fn(async (input: { amount: number }) =>
    overrides.captureError
      ? { err: overrides.captureError, val: null }
      : { err: null, val: { capturedAmount: input.amount } }
  )
  const extendReservation = vi.fn(async (input: { requestedAmount: number }) =>
    overrides.extendError
      ? { err: overrides.extendError, val: null }
      : { err: null, val: { grantedAmount: overrides.extendAmount ?? input.requestedAmount } }
  )
  const releaseReservation = vi.fn(async () =>
    overrides.releaseError
      ? { err: overrides.releaseError, val: null }
      : {
          err: null,
          val: {
            releasedAmount: 0,
            restoredGrantedAmount: 0,
            refundedPurchasedAmount: 0,
          },
        }
  )
  const operations = {
    captureReservationUsage,
    createReservation,
    extendReservation,
    releaseReservation,
  } as unknown as EntitlementWindowWalletOps

  return {
    captureReservationUsage,
    createReservation,
    extendReservation,
    provider: { get: () => operations },
    releaseReservation,
  }
}

function seedWallet(
  store: InMemoryEntitlementWindowStore,
  overrides: Partial<NonNullable<WalletReservationSnapshot>> = {}
) {
  store.walletRow = {
    projectId: "proj_123",
    customerId: "cus_123",
    currency: "USD",
    reservationEndAt: BASE_NOW + 60_000,
    billingPeriodId: "bp_123",
    cycleEndAt: BASE_NOW + 60_000,
    cycleStartAt: BASE_NOW - 60_000,
    featurePlanVersionItemId: "item_123",
    featureSlug: "api_calls",
    statementKey: "stmt_123",
    reservationId: "res_seeded",
    allocationAmount: 1_000_000_000,
    consumedAmount: 0,
    flushedAmount: 0,
    consumedQuantity: 0,
    flushedQuantity: 0,
    refillThresholdBps: 2000,
    refillChunkAmount: 200_000_000,
    targetReservationAmount: 1_000_000_000,
    spendEwmaAmount: 0,
    lastRateSampledAtMs: null,
    maxEventCostAmount: 0,
    pendingRefillAmount: 0,
    pendingFlushAmount: null,
    pendingFlushQuantity: null,
    refillInFlight: false,
    flushSeq: 0,
    pendingFlushSeq: null,
    pendingFlushFinal: false,
    lastEventAt: BASE_NOW,
    lastFlushedAt: BASE_NOW,
    deletionRequested: false,
    recoveryRequired: false,
    ...overrides,
  }
}

function createBatchInput(
  input: ReturnType<typeof createApplyInput>,
  amounts: number[],
  idPrefix = "batch"
) {
  return {
    customerId: input.customerId,
    entitlement: input.entitlement,
    enforceLimit: input.enforceLimit,
    events: amounts.map((amount, index) => ({
      ...input.event,
      correlationKey: `${idPrefix}_${index}`,
      id: `evt_${idPrefix}_${index}`,
      idempotencyKey: `idem_${idPrefix}_${index}`,
      now: input.now + index,
      properties: { amount },
      timestamp: input.event.timestamp + index,
    })),
    grants: input.grants,
    projectId: input.projectId,
  }
}

const VOLUME_FLAT_TIER_PRICE_CONFIG = {
  tierMode: "volume" as const,
  usageMode: "tier" as const,
  tiers: [
    {
      firstUnit: 1,
      lastUnit: 30,
      unitPrice: {
        dinero: { amount: 0, currency: { code: "EUR", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: "0.00",
      },
      flatPrice: {
        dinero: { amount: 0, currency: { code: "EUR", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: "0.00",
      },
    },
    {
      firstUnit: 31,
      lastUnit: null,
      unitPrice: {
        dinero: { amount: 1, currency: { code: "EUR", base: 10, exponent: 2 }, scale: 3 },
        displayAmount: "0.001",
      },
      flatPrice: {
        dinero: { amount: 100, currency: { code: "EUR", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: "1",
      },
    },
  ],
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

  it("uses the required external reservation remaining amount for budget checks", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()

    const accepted = await harness.processor.apply({
      ...createLiveApplyInput(now, {
        idempotencyKey: "idem_external_budget_funded",
        event: { id: "evt_external_budget_funded" },
      }),
      wallet: { mode: "external_reservation", remainingAmount: 100_000_000 },
    })
    const denied = await harness.processor.apply({
      ...createLiveApplyInput(now, {
        idempotencyKey: "idem_external_budget_empty",
        event: { id: "evt_external_budget_empty" },
      }),
      wallet: { mode: "external_reservation", remainingAmount: 0 },
    })

    expect(accepted).toMatchObject({ allowed: true })
    expect(denied).toMatchObject({
      allowed: false,
      deniedReason: "RUN_BUDGET_EXCEEDED",
    })
  })

  it("rejects legacy wallet fields before writing processor state", async () => {
    const now = Date.now()
    const harness = createHarness({ now })
    await harness.processor.initialize()
    const malformedInput = {
      ...createLiveApplyInput(now),
      walletMode: "external_reservation",
      externalReservation: { remainingAmount: 100_000_000 },
    } as unknown as ApplyInput

    await expect(harness.processor.apply(malformedInput)).rejects.toThrow()
    expect(harness.store.idempotency.size).toBe(0)
    expect(harness.store.meterStates.size).toBe(0)
    expect(harness.store.grantStates.size).toBe(0)
    expect(harness.getAlarmAt()).toBeNull()
  })
})

describe("EntitlementWindowProcessor apply behavior", () => {
  it.each([
    { name: "after the grace window", offset: -1, allowed: false },
    { name: "inside the grace window", offset: 1, allowed: true },
  ])("handles a late event $name", async ({ offset, allowed }) => {
    const now = BASE_NOW
    const harness = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const periodEndAt = now - LATE_EVENT_GRACE_MS + offset
    const result = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        now,
        periodStartAt: periodEndAt - 60_000,
        periodEndAt,
        event: { timestamp: periodEndAt - 1 },
      })
    )

    expect(result.allowed).toBe(allowed)
    if (!allowed) {
      expect(result).toMatchObject({ deniedReason: "LATE_EVENT_CLOSED_PERIOD" })
      expect(harness.store.meterStates.size).toBe(0)
    }
  })

  it("resets period usage, assigns boundary events, and isolates late prior-period usage", async () => {
    const nowDate = new Date(BASE_NOW)
    const periodBStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)
    const periodAStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1)
    const harness = createHarness({
      now: periodBStart,
      store: new InMemoryEntitlementWindowStore(),
    })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "uncapped",
      enforceLimit: true,
      limit: 4,
      periodStartAt: periodAStart,
      periodEndAt: Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1),
      resetConfig: { resetInterval: "month", resetIntervalCount: 1 },
    })

    const previous = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_period_previous",
      now: periodBStart - 1,
      event: {
        ...base.event,
        id: "evt_period_previous",
        properties: { amount: 3 },
        timestamp: periodBStart - 1,
      },
    })
    const current = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_period_current",
      now: periodBStart,
      event: {
        ...base.event,
        id: "evt_period_current",
        properties: { amount: 1 },
        timestamp: periodBStart,
      },
    })
    const replay = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_period_previous",
      now: periodBStart,
      event: {
        ...base.event,
        id: "evt_period_previous",
        properties: { amount: 3 },
        timestamp: periodBStart - 1,
      },
    })

    expect(previous.meterFacts?.[0]?.period_key).toBe(`month:${periodAStart}`)
    expect(current.meterFacts?.[0]?.period_key).toBe(`month:${periodBStart}`)
    expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
    await expect(
      harness.processor.getEnforcementState({
        entitlement: base.entitlement,
        grants: base.grants,
        now: periodBStart,
      })
    ).resolves.toMatchObject({ usage: 1, limit: 4, isLimitReached: false })
  })

  it("preserves sub-cent pricing across repeated events", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const priceConfig = {
      usageMode: "unit",
      price: {
        dinero: {
          amount: 3,
          currency: { code: "USD", base: 10, exponent: 2 },
          scale: 6,
        },
        displayAmount: "0.000003",
      },
    }
    let total = 0

    for (let index = 0; index < 100; index++) {
      const result = await harness.processor.apply(
        createApplyInput({
          creditLinePolicy: "uncapped",
          idempotencyKey: `idem_micro_${index}`,
          event: { id: `evt_micro_${index}`, properties: { amount: 1 } },
          priceConfig,
        })
      )
      total += result.meterFacts?.[0]?.amount ?? 0
    }

    expect(total).toBe(30_000)
  })

  it("splits usage across grants in priority order and honors replacement grant input", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const grants = [
      createGrantSnapshot({ grantId: "grant_priority", amount: 2, priority: 20 }),
      createGrantSnapshot({ grantId: "grant_fallback", amount: 4, priority: 10 }),
    ]
    const first = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        grants,
        idempotencyKey: "idem_grant_split",
        event: { id: "evt_grant_split", properties: { amount: 5 } },
      })
    )
    const second = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        grants: [
          ...grants,
          createGrantSnapshot({ grantId: "grant_new", amount: 10, priority: 30 }),
        ],
        idempotencyKey: "idem_grant_new",
        event: { id: "evt_grant_new", properties: { amount: 2 } },
      })
    )

    expect(first.meterFacts?.map((fact) => [fact.grant_id, fact.delta])).toEqual([
      ["grant_priority", 2],
      ["grant_fallback", 3],
    ])
    expect(second.meterFacts?.[0]).toMatchObject({ grant_id: "grant_new", delta: 2 })
  })

  it.each([
    { strategy: "none", expectedAllowed: false },
    { strategy: "always", expectedAllowed: true },
  ])("applies $strategy overage enforcement", async ({ strategy, expectedAllowed }) => {
    const now = BASE_NOW
    const harness = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const input = createApplyInput({
      creditLinePolicy: "uncapped",
      enforceLimit: true,
      limit: 2,
      overageStrategy: strategy,
      event: { properties: { amount: 3 } },
    })
    const result = await harness.processor.apply(input)

    expect(result.allowed).toBe(expectedAllowed)
    expect(harness.store.idempotency.get(input.idempotencyKey)?.allowed).toBe(expectedAllowed)
    if (!expectedAllowed) expect(harness.store.grantStates.size).toBe(0)
  })

  it("allows the last crossing call and rejects later usage", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "uncapped",
      enforceLimit: true,
      limit: 3,
      overageStrategy: "last-call",
      event: { properties: { amount: 4 } },
    })

    const crossing = await harness.processor.apply(base)
    const after = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_after_crossing",
      event: { ...base.event, id: "evt_after_crossing", properties: { amount: 1 } },
    })

    expect(crossing).toMatchObject({ allowed: true })
    expect(after).toMatchObject({ allowed: false, deniedReason: "LIMIT_EXCEEDED" })
  })

  it("keeps free and uncapped usage off the wallet path", async () => {
    const wallet = createWalletHarness()
    const harness = createHarness({
      now: BASE_NOW,
      store: new InMemoryEntitlementWindowStore(),
      wallet: wallet.provider,
    })
    await harness.processor.initialize()
    const freeConfig = {
      usageMode: "unit",
      price: {
        dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: "0",
      },
    }

    await harness.processor.apply(createApplyInput({ priceConfig: freeConfig }))
    await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        idempotencyKey: "idem_uncapped",
        event: { id: "evt_uncapped" },
      })
    )

    expect(wallet.createReservation).not.toHaveBeenCalled()
    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
  })
})

describe("EntitlementWindowProcessor pricing behavior", () => {
  it("charges a volume-tier flat fee once at the paid boundary", async () => {
    const harness = createHarness({ now: BASE_NOW, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "uncapped",
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
    })

    const free = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_tier_free",
      event: { ...base.event, id: "evt_tier_free", properties: { amount: 30 } },
    })
    const crossing = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_tier_crossing",
      event: { ...base.event, id: "evt_tier_crossing", properties: { amount: 1 } },
    })
    const inside = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_tier_inside",
      event: { ...base.event, id: "evt_tier_inside", properties: { amount: 1 } },
    })

    expect(free.meterFacts?.[0]).toMatchObject({ amount: 0, value_after: 30 })
    expect(crossing.meterFacts?.[0]).toMatchObject({
      amount: 103_100_000,
      amount_after: 103_100_000,
      value_after: 31,
      tier_mode: "volume",
    })
    expect(inside.meterFacts?.[0]).toMatchObject({
      amount: 100_000,
      amount_after: 103_200_000,
      value_after: 32,
    })
  })

  it("captures the flat fee when one event jumps directly into the paid tier", async () => {
    const harness = createHarness({ now: BASE_NOW, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const result = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        currency: "EUR",
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        event: { properties: { amount: 50 } },
      })
    )

    expect(result.meterFacts?.[0]).toMatchObject({
      amount: 105_000_000,
      amount_after: 105_000_000,
      delta: 50,
    })
  })

  it("does not bootstrap in the free tier and sizes paid bootstrap from marginal cost", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "capped",
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
    })

    await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_tier_bootstrap_free",
      event: { ...base.event, id: "evt_tier_bootstrap_free", properties: { amount: 30 } },
    })
    expect(wallet.createReservation).not.toHaveBeenCalled()

    const paid = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_tier_bootstrap_paid",
      event: { ...base.event, id: "evt_tier_bootstrap_paid", properties: { amount: 1 } },
    })
    expect(paid).toMatchObject({ allowed: true })
    expect(wallet.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "EUR", requestedAmount: 103_100_000 })
    )
  })
})

describe("EntitlementWindowProcessor batch behavior", () => {
  it("matches sequential priced facts and seals duplicate keys once", async () => {
    const now = BASE_NOW
    const base = createApplyInput({ creditLinePolicy: "uncapped" })
    const batchStore = new InMemoryEntitlementWindowStore()
    const batch = createHarness({ now, store: batchStore })
    await batch.processor.initialize()
    const batchInput = createBatchInput(base, [1, 2, 3], "parity")
    const batched = await batch.processor.applyBatch(batchInput)

    const sequential = createHarness({ now, store: new InMemoryEntitlementWindowStore() })
    await sequential.processor.initialize()
    const sequentialFacts = []
    for (const event of batchInput.events) {
      const result = await sequential.processor.apply({
        ...base,
        event,
        idempotencyKey: event.idempotencyKey,
        now: event.now,
      })
      sequentialFacts.push(...(result.meterFacts ?? []))
    }

    expect(batched.results.flatMap((result) => result.meterFacts ?? [])).toEqual(sequentialFacts)

    const repeatedKey = {
      ...createBatchInput(base, [1, 1], "duplicate"),
      events: createBatchInput(base, [1, 1], "duplicate").events.map((event) => ({
        ...event,
        idempotencyKey: "idem_repeated_in_batch",
      })),
    }
    const duplicateResult = await batch.processor.applyBatch(repeatedKey)
    expect(duplicateResult.results).toHaveLength(2)
    expect(batchStore.idempotency.has("idem_repeated_in_batch")).toBe(true)
    expect(
      [...batchStore.idempotency].filter(([key]) => key === "idem_repeated_in_batch")
    ).toHaveLength(1)
  })

  it("persists mixed allowed, denied, and replayed outcomes atomically", async () => {
    const now = BASE_NOW
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now, store })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "uncapped",
      enforceLimit: true,
      limit: 3,
    })
    const input = createBatchInput(base, [2, 2, 1], "mixed")
    input.events[2]!.idempotencyKey = input.events[0]!.idempotencyKey
    const result = await harness.processor.applyBatch(input)

    expect(
      result.results.map(({ allowed, idempotencyStatus }) => ({ allowed, idempotencyStatus }))
    ).toEqual([
      { allowed: true, idempotencyStatus: undefined },
      { allowed: false, idempotencyStatus: undefined },
      { allowed: true, idempotencyStatus: "already_reported" },
    ])
    expect(store.idempotency.size).toBe(2)
    expect(store.grantStates.values().next().value?.consumedInCurrentWindow).toBe(2)
  })

  it("replays a committed batch from a fresh processor over the same store", async () => {
    const now = BASE_NOW
    const store = new InMemoryEntitlementWindowStore()
    const first = createHarness({ now, store })
    await first.processor.initialize()
    const input = createBatchInput(createApplyInput({ creditLinePolicy: "uncapped" }), [2], "evict")
    const original = await first.processor.applyBatch(input)

    const revived = createHarness({ now, store })
    await revived.processor.initialize()
    const replay = await revived.processor.applyBatch(input)

    expect(replay.results[0]).toEqual({
      ...original.results[0],
      idempotencyStatus: "already_reported",
    })
    expect(store.meterStates.values().next().value?.usage).toBe(2)
  })

  it("keeps a zero-cost optimized batch off the wallet path", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const freeConfig = {
      usageMode: "unit",
      price: {
        dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: "0",
      },
    }
    const result = await harness.processor.applyBatch(
      createBatchInput(
        createApplyInput({ creditLinePolicy: "capped", priceConfig: freeConfig }),
        [1, 1]
      )
    )

    expect(result.results).toHaveLength(2)
    expect(
      result.results.flatMap((row) => row.meterFacts ?? []).map((fact) => fact.amount)
    ).toEqual([0, 0])
    expect(wallet.createReservation).not.toHaveBeenCalled()
    expect(store.walletRow).toBeNull()
  })

  it("bootstraps and commits a compact priced batch once", async () => {
    const wallet = createWalletHarness({ allocationAmount: 1_000_000_000 })
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const result = await harness.processor.applyBatch(
      createBatchInput(createApplyInput({ creditLinePolicy: "capped" }), [1, 2, 3], "wallet")
    )

    expect(result.results.every((row) => row.allowed)).toBe(true)
    expect(wallet.createReservation).toHaveBeenCalledTimes(1)
    expect(store.walletRow).toMatchObject({ consumedAmount: 600_000_000, consumedQuantity: 6 })
    expect(store.idempotency.size).toBe(3)
  })

  it("grows an underfunded optimized batch and preserves all priced facts", async () => {
    const wallet = createWalletHarness({ extendAmount: 1_000_000_000 })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { allocationAmount: 100_000_000, targetReservationAmount: 100_000_000 })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const result = await harness.processor.applyBatch(
      createBatchInput(createApplyInput({ creditLinePolicy: "capped" }), [2, 2], "grow")
    )
    await Promise.all(harness.waitUntilPromises)

    expect(result.results.every((row) => row.allowed)).toBe(true)
    expect(wallet.extendReservation).toHaveBeenCalled()
    expect(result.results.flatMap((row) => row.meterFacts ?? [])).toHaveLength(2)
    expect(store.walletRow?.consumedAmount).toBe(400_000_000)
  })

  it("seals wallet-empty outcomes while allowing earlier funded batch events", async () => {
    const wallet = createWalletHarness({ extendAmount: 0 })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { allocationAmount: 200_000_000, targetReservationAmount: 200_000_000 })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const result = await harness.processor.applyBatch(
      createBatchInput(createApplyInput({ creditLinePolicy: "capped" }), [1, 2], "wallet_empty")
    )

    expect(result.results[0]).toMatchObject({ allowed: true })
    expect(result.results[1]).toMatchObject({ allowed: false, deniedReason: "WALLET_EMPTY" })
    expect(store.idempotency.get("idem_wallet_empty_1")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
  })

  it("denies the first optimized batch event beyond max outstanding headroom", async () => {
    const wallet = createWalletHarness({ extendAmount: 0 })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 3_000_000_000,
      targetReservationAmount: 3_000_000_000,
      maxEventCostAmount: 1_000_000_000,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const result = await harness.processor.applyBatch(
      createBatchInput(
        createApplyInput({ creditLinePolicy: "capped" }),
        [10, 10, 10, 10],
        "max_outstanding"
      )
    )

    expect(
      result.results.map((row) => ({ allowed: row.allowed, reason: row.deniedReason }))
    ).toEqual([
      { allowed: true, reason: undefined },
      { allowed: true, reason: undefined },
      { allowed: true, reason: undefined },
      { allowed: false, reason: "WALLET_EMPTY" },
    ])
    expect(store.idempotency.get("idem_max_outstanding_3")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(result.results.flatMap((row) => row.meterFacts ?? [])).toHaveLength(3)
    expect(store.walletRow?.consumedAmount).toBe(3_000_000_000)
  })

  it("closes an active reservation after a staged hard-limit denial", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store)
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const result = await harness.processor.applyBatch(
      createBatchInput(
        createApplyInput({ creditLinePolicy: "capped", enforceLimit: true, limit: 1 }),
        [1, 1],
        "limit_close"
      )
    )
    await Promise.all(harness.waitUntilPromises)

    expect(result.results.map((row) => row.allowed)).toEqual([true, false])
    expect(wallet.releaseReservation).toHaveBeenCalledTimes(1)
    expect(store.walletRow?.reservationId).toBeNull()
  })
})

describe("EntitlementWindowProcessor wallet behavior", () => {
  it("deduplicates concurrent same-key applies during wallet bootstrap", async () => {
    const reservationStarted = createDeferred<void>()
    const reservationResult = createDeferred<{
      err: null
      val: { reservationId: string; allocationAmount: number }
    }>()
    const wallet = createWalletHarness()
    wallet.createReservation.mockImplementation(async () => {
      reservationStarted.resolve()
      return reservationResult.promise
    })
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const input = createApplyInput({
      creditLinePolicy: "capped",
      event: { properties: { amount: 3 } },
    })

    const first = harness.processor.apply(input)
    await reservationStarted.promise
    const second = harness.processor.apply(input)
    await Promise.resolve()
    expect(wallet.createReservation).toHaveBeenCalledTimes(1)

    reservationResult.resolve({
      err: null,
      val: { reservationId: "res_concurrent_bootstrap", allocationAmount: 1_000_000_000 },
    })
    const results = await Promise.all([first, second])

    expect(results).toEqual([
      expect.objectContaining({ allowed: true }),
      expect.objectContaining({ allowed: true }),
    ])
    expect(wallet.createReservation).toHaveBeenCalledTimes(1)
    expect(store.idempotency.size).toBe(1)
    expect(store.meterStates.values().next().value?.usage).toBe(3)
    expect(store.walletRow).toMatchObject({
      reservationId: "res_concurrent_bootstrap",
      consumedAmount: 300_000_000,
    })
  })

  it("opens a priced capped reservation lazily and stamps consumption", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    const result = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "capped",
        event: { properties: { amount: 3 } },
      })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(wallet.createReservation).toHaveBeenCalledTimes(1)
    expect(wallet.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedAmount: 300_000_000,
      })
    )
    expect(store.walletRow).toMatchObject({
      reservationId: "res_test",
      consumedAmount: 300_000_000,
      consumedQuantity: 3,
      lastEventAt: BASE_NOW,
    })
  })

  it.each([
    { allocationAmount: 0, name: "empty", expected: "WALLET_EMPTY" },
    { allocationAmount: 100_000_000, name: "partially funded", expected: "WALLET_EMPTY" },
  ])(
    "seals $name bootstrap denials without local consumption",
    async ({ allocationAmount, expected }) => {
      const wallet = createWalletHarness({ allocationAmount, extendAmount: 0 })
      const store = new InMemoryEntitlementWindowStore()
      const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
      await harness.processor.initialize()
      const input = createApplyInput({
        creditLinePolicy: "capped",
        event: { properties: { amount: 3 } },
      })

      const first = await harness.processor.apply(input)
      const replay = await harness.processor.apply(input)

      expect(first).toMatchObject({ allowed: false, deniedReason: expected })
      expect(replay).toMatchObject({
        allowed: false,
        deniedReason: expected,
        idempotencyStatus: "already_reported",
      })
      expect(store.grantStates.size).toBe(0)
    }
  )

  it("propagates wallet bootstrap errors without caching a business denial", async () => {
    const wallet = createWalletHarness({ createError: new Error("wallet unavailable") })
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.apply(createApplyInput({ creditLinePolicy: "capped" }))
    ).rejects.toThrow("wallet unavailable")
    expect(store.idempotency.size).toBe(0)
    expect(store.grantStates.size).toBe(0)
  })

  it("grows an underfunded reservation and folds the flush result into state", async () => {
    const wallet = createWalletHarness({ extendAmount: 500_000_000 })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 100_000_000,
      targetReservationAmount: 500_000_000,
      refillChunkAmount: 500_000_000,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    const result = await harness.processor.apply(
      createApplyInput({ creditLinePolicy: "capped", event: { properties: { amount: 3 } } })
    )
    await Promise.all(harness.waitUntilPromises)

    expect(result).toMatchObject({ allowed: true })
    expect(wallet.captureReservationUsage).toHaveBeenCalled()
    expect(wallet.extendReservation).toHaveBeenCalled()
    expect(store.walletRow).toMatchObject({
      consumedAmount: 300_000_000,
      pendingFlushSeq: null,
      refillInFlight: false,
    })
  })

  it.each([
    { failure: "capture", overrides: { captureError: new Error("capture failed") } },
    { failure: "extend", overrides: { extendError: new Error("extend failed") } },
  ])("preserves pending flush intent when wallet $failure fails", async ({ overrides }) => {
    const wallet = createWalletHarness(overrides)
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 500_000_000,
      consumedAmount: 350_000_000,
      consumedQuantity: 3.5,
      targetReservationAmount: 500_000_000,
      refillChunkAmount: 200_000_000,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.apply(
        createApplyInput({ creditLinePolicy: "capped", event: { properties: { amount: 1 } } })
      )
    ).resolves.toMatchObject({ allowed: true })
    await Promise.all(harness.waitUntilPromises)
    expect(store.walletRow).toMatchObject({
      flushSeq: 0,
      pendingFlushSeq: 1,
      refillInFlight: false,
    })
  })

  it("does not trigger another refill while one is already pending", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 500_000_000,
      consumedAmount: 100_000_000,
      pendingFlushAmount: 100_000_000,
      pendingFlushQuantity: 1,
      pendingFlushSeq: 1,
      pendingRefillAmount: 200_000_000,
      refillInFlight: true,
      flushSeq: 1,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    await harness.processor.apply(createApplyInput({ creditLinePolicy: "capped" }))

    expect(store.walletRow).toMatchObject({
      consumedAmount: 200_000_000,
      pendingFlushSeq: 1,
      flushSeq: 1,
    })
    expect(wallet.extendReservation).not.toHaveBeenCalled()
  })

  it("clamps negative corrections so consumed amount never falls below flushed", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "capped",
        idempotencyKey: "idem_positive_before_correction",
        event: { id: "evt_positive_before_correction", properties: { amount: 4 } },
      })
    )
    await Promise.all(harness.waitUntilPromises)
    store.updateWalletReservation({ flushedAmount: 300_000_000, flushedQuantity: 3 })
    await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "capped",
        idempotencyKey: "idem_negative_correction",
        event: { id: "evt_negative_correction", properties: { amount: -10 } },
      })
    )

    expect(store.walletRow?.consumedAmount).toBe(300_000_000)
    expect(store.walletRow?.consumedAmount).toBeGreaterThanOrEqual(
      store.walletRow?.flushedAmount ?? 0
    )
  })

  it("uses external reservation remaining amount without entitlement wallet side effects", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const base = createApplyInput({
      creditLinePolicy: "capped",
      event: { properties: { amount: 2 } },
    })

    const accepted = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_external_ok",
      wallet: { mode: "external_reservation", remainingAmount: 200_000_000 },
    })
    const denied = await harness.processor.apply({
      ...base,
      idempotencyKey: "idem_external_denied",
      event: { ...base.event, id: "evt_external_denied" },
      wallet: { mode: "external_reservation", remainingAmount: 199_999_999 },
    })

    expect(accepted).toMatchObject({ allowed: true })
    expect(denied).toMatchObject({ allowed: false, deniedReason: "RUN_BUDGET_EXCEEDED" })
    expect(wallet.createReservation).not.toHaveBeenCalled()
    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
    expect(store.walletRow).toBeNull()
  })

  it("does not persist pending refill intent when invoice context is missing", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      statementKey: null,
      allocationAmount: 100_000_000,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.apply(
        (() => {
          const input = createApplyInput({
            creditLinePolicy: "capped",
            event: { properties: { amount: 2 } },
          })
          return { ...input, entitlement: { ...input.entitlement, billingPeriods: [] } }
        })()
      )
    ).rejects.toThrow("Missing billing period invoice context")
    expect(store.walletRow).toMatchObject({ pendingFlushSeq: null, refillInFlight: false })
    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
  })

  it("refreshes missing reservation invoice context before wallet spend", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      featureSlug: null,
      statementKey: null,
      refillThresholdBps: 0,
      refillChunkAmount: 0,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.apply(createApplyInput({ creditLinePolicy: "capped" }))
    ).resolves.toMatchObject({ allowed: true })
    expect(store.walletRow).toMatchObject({
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      consumedAmount: 100_000_000,
    })
  })

  it("flushes matching unflushed usage for invoicing and reports no-op outcomes", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.flushReservationForInvoicing({
        statementKey: "stmt_123",
        billingPeriodIds: ["bp_123"],
      })
    ).resolves.toMatchObject({ ok: true, outcome: "no_reservation" })

    seedWallet(store, { consumedAmount: 300_000_000, consumedQuantity: 3 })
    await expect(
      harness.processor.flushReservationForInvoicing({
        statementKey: "other_stmt",
        billingPeriodIds: [],
      })
    ).resolves.toMatchObject({ ok: false, outcome: "statement_mismatch" })

    await expect(
      harness.processor.flushReservationForInvoicing({
        statementKey: "stmt_123",
        billingPeriodIds: ["bp_123"],
      })
    ).resolves.toMatchObject({ ok: true, outcome: "flushed" })
    expect(wallet.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300_000_000, flushSeq: 1 })
    )
    expect(store.walletRow).toMatchObject({
      flushedAmount: 300_000_000,
      reservationId: "res_seeded",
    })

    await expect(
      harness.processor.flushReservationForInvoicing({
        statementKey: "stmt_123",
        billingPeriodIds: ["bp_123"],
      })
    ).resolves.toMatchObject({ ok: true, outcome: "no_unflushed_usage" })
  })
})

describe("EntitlementWindowProcessor reads and lifecycle", () => {
  it("returns safe enforcement defaults and refreshes the read cache after apply", async () => {
    const now = BASE_NOW
    let invalidate = () => {}
    const store = new InMemoryEntitlementWindowStore(() => invalidate())
    const harness = createEntitlementWindowProcessorHarness({ now, store })
    invalidate = () => harness.processor.invalidateEnforcementStateCache()
    await harness.processor.initialize()
    const input = createApplyInput({ creditLinePolicy: "uncapped", limit: 5 })

    await expect(
      harness.processor.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now,
      })
    ).resolves.toMatchObject({ usage: 0, limit: 5, isLimitReached: false })

    await harness.processor.apply({
      ...input,
      event: { ...input.event, properties: { amount: 3 } },
    })
    await expect(
      harness.processor.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now,
      })
    ).resolves.toMatchObject({ usage: 3, limit: 5, isLimitReached: false })
  })

  it("reports operational status without mutating state", async () => {
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      consumedAmount: 300,
      flushedAmount: 100,
      consumedQuantity: 3,
      flushedQuantity: 1,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: createWalletHarness().provider })
    await harness.processor.initialize()
    const before = structuredClone(store.walletRow)

    const status = await harness.processor.getStatus()

    expect(status).toMatchObject({
      durableObjectId: "window_test_1",
      outboxCount: 0,
      walletReservation: {
        unflushedAmount: 200,
        unflushedQuantity: 2,
      },
    })
    expect(store.walletRow).toEqual(before)
  })

  it("schedules the earliest alarm and retains the earlier deadline", async () => {
    const harness = createHarness({ now: BASE_NOW, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()
    const first = createApplyInput({
      creditLinePolicy: "uncapped",
      periodEndAt: BASE_NOW + 30_000,
    })
    await harness.processor.apply(first)
    await Promise.all(harness.waitUntilPromises)
    const earliest = harness.getAlarmAt()

    await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        idempotencyKey: "idem_later_alarm",
        event: { id: "evt_later_alarm" },
        periodEndAt: BASE_NOW + 120_000,
      })
    )
    await Promise.all(harness.waitUntilPromises)
    expect(harness.getAlarmAt()).toBe(earliest)
  })

  it("cleans stale idempotency at the durable TTL while retaining the safety margin", async () => {
    const store = new InMemoryEntitlementWindowStore()
    const baseEntry = {
      eventId: "",
      createdAt: BASE_NOW,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
      meterFacts: [],
    }
    store.idempotency.set("inside", {
      ...baseEntry,
      eventId: "inside",
      createdAt: BASE_NOW - DO_IDEMPOTENCY_TTL_MS + 1,
    })
    store.idempotency.set("outside", {
      ...baseEntry,
      eventId: "outside",
      createdAt: BASE_NOW - DO_IDEMPOTENCY_TTL_MS - 1,
    })
    const harness = createHarness({ now: BASE_NOW, store })
    await harness.processor.initialize()
    await harness.processor.alarm()

    expect(store.idempotency.has("inside")).toBe(true)
    expect(store.idempotency.has("outside")).toBe(false)
  })

  it("marks deletion, closes the reservation, and destroys the window", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { consumedAmount: 200_000_000, consumedQuantity: 2 })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await harness.processor.requestDeletion()
    expect(store.walletRow?.deletionRequested).toBe(true)
    await harness.processor.alarm()

    expect(wallet.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(wallet.releaseReservation).toHaveBeenCalledTimes(1)
    expect(store.walletRow?.reservationId).toBeNull()
    expect(harness.wasDestroyed()).toBe(true)
  })

  it("preserves pending wallet recovery for an operator during deletion", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      consumedAmount: 200_000_000,
      flushedAmount: 100_000_000,
      consumedQuantity: 2,
      flushedQuantity: 1,
      refillInFlight: true,
      flushSeq: 1,
      pendingFlushSeq: 2,
      pendingFlushAmount: 100_000_000,
      pendingFlushQuantity: 1,
      pendingRefillAmount: 400_000_000,
      deletionRequested: true,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await harness.processor.alarm()

    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
    expect(wallet.extendReservation).not.toHaveBeenCalled()
    expect(wallet.releaseReservation).not.toHaveBeenCalled()
    expect(harness.wasDestroyed()).toBe(false)
    expect(store.walletRow).toMatchObject({
      reservationId: "res_seeded",
      deletionRequested: true,
      refillInFlight: true,
      flushSeq: 1,
      pendingFlushSeq: 2,
      pendingFlushAmount: 100_000_000,
      pendingRefillAmount: 400_000_000,
    })
  })

  it("keeps a live reservation open before inactivity and closes it after the threshold", async () => {
    let now = BASE_NOW
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { lastEventAt: BASE_NOW, reservationEndAt: BASE_NOW + 24 * 60 * 60_000 })
    const harness = createHarness({
      now: () => now,
      store,
      timing: { inactivityThresholdMs: 60_000 },
      wallet: wallet.provider,
    })
    await harness.processor.initialize()

    now = BASE_NOW + 59_999
    await harness.processor.alarm()
    expect(wallet.releaseReservation).not.toHaveBeenCalled()
    expect(store.walletRow?.reservationId).toBe("res_seeded")

    now = BASE_NOW + 60_001
    await harness.processor.alarm()
    expect(wallet.releaseReservation).toHaveBeenCalledTimes(1)
    expect(store.walletRow?.reservationId).toBeNull()
  })

  it("time-based wallet flush captures usage without requesting a zero refill", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 1_000_000_000,
      consumedAmount: 595_600_000,
      consumedQuantity: 12,
      flushedAmount: 0,
      flushedQuantity: 0,
      flushSeq: 2,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 10 * 60_000,
      reservationEndAt: BASE_NOW + 2 * 60 * 60_000,
    })
    const harness = createHarness({
      now: BASE_NOW,
      store,
      timing: { inactivityThresholdMs: 60 * 60_000, maxFlushIntervalMs: 5 * 60_000 },
      wallet: wallet.provider,
    })
    await harness.processor.initialize()

    await harness.processor.alarm()

    expect(wallet.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 595_600_000, flushSeq: 3, statementKey: "stmt_123" })
    )
    expect(wallet.extendReservation).not.toHaveBeenCalled()
    expect(wallet.releaseReservation).not.toHaveBeenCalled()
    expect(store.walletRow).toMatchObject({
      allocationAmount: 1_000_000_000,
      flushedAmount: 595_600_000,
      flushedQuantity: 12,
      flushSeq: 3,
      pendingFlushSeq: null,
      pendingFlushAmount: null,
      pendingRefillAmount: 0,
      refillInFlight: false,
    })
  })

  it("skips automatic close while recovery is required", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { recoveryRequired: true, reservationEndAt: BASE_NOW - 1 })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    await harness.processor.alarm()

    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
    expect(wallet.releaseReservation).not.toHaveBeenCalled()
    expect(store.walletRow?.reservationId).toBe("res_seeded")
  })

  it("does not auto-recover a pending flush marked recoveryRequired", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      consumedAmount: 300_000_000,
      pendingFlushAmount: 200_000_000,
      pendingFlushQuantity: 2,
      pendingFlushSeq: 5,
      pendingRefillAmount: 200_000_000,
      flushSeq: 4,
      recoveryRequired: true,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })

    await harness.processor.initialize()
    await Promise.all(harness.waitUntilPromises)

    expect(harness.waitUntilPromises).toHaveLength(0)
    expect(wallet.captureReservationUsage).not.toHaveBeenCalled()
    expect(wallet.extendReservation).not.toHaveBeenCalled()
    expect(store.walletRow).toMatchObject({
      flushSeq: 4,
      pendingFlushSeq: 5,
      pendingFlushAmount: 200_000_000,
      pendingRefillAmount: 200_000_000,
      recoveryRequired: true,
    })
  })

  it("recovers a persisted pending final close with the same flush sequence", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      consumedAmount: 200_000_000,
      consumedQuantity: 2,
      pendingFlushAmount: 200_000_000,
      pendingFlushQuantity: 2,
      pendingFlushSeq: 1,
      pendingFlushFinal: true,
      refillInFlight: true,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    await Promise.all(harness.waitUntilPromises)

    expect(wallet.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200_000_000, flushSeq: 1 })
    )
    expect(wallet.releaseReservation).toHaveBeenCalledTimes(1)
    expect(store.walletRow?.reservationId).toBeNull()
  })

  it("leaves a failed final flush for operator recovery", async () => {
    const wallet = createWalletHarness({ releaseError: new Error("release failed") })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, { reservationEndAt: BASE_NOW - 1 })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await harness.processor.alarm()

    expect(store.walletRow).toMatchObject({ recoveryRequired: true, reservationId: "res_seeded" })
    expect(harness.wasDestroyed()).toBe(false)
  })

  it("replays the exact persisted pending flush and refill payload on initialization", async () => {
    const wallet = createWalletHarness({ extendAmount: 200_000_000 })
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store, {
      allocationAmount: 1_000_000_000,
      consumedAmount: 300_000_000,
      refillChunkAmount: 900_000_000,
      pendingFlushAmount: 300_000_000,
      pendingFlushQuantity: 3,
      pendingFlushSeq: 1,
      pendingRefillAmount: 200_000_000,
      refillInFlight: true,
    })
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })

    await harness.processor.initialize()
    await Promise.all(harness.waitUntilPromises)

    expect(wallet.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300_000_000, flushSeq: 1 })
    )
    expect(wallet.extendReservation).toHaveBeenCalledWith(
      expect.objectContaining({ flushSeq: 1, requestedAmount: 200_000_000 })
    )
    expect(wallet.releaseReservation).not.toHaveBeenCalled()
    expect(store.walletRow).toMatchObject({
      allocationAmount: 1_200_000_000,
      flushSeq: 1,
      flushedAmount: 300_000_000,
      flushedQuantity: 3,
      pendingFlushSeq: null,
      pendingFlushAmount: null,
      pendingRefillAmount: 0,
      refillInFlight: false,
    })
  })
})

describeEntitlementWindowProcessorContract(
  "EntitlementWindowProcessor (in-memory store contract)",
  createEntitlementWindowStoreContractHostFactory(() => new InMemoryEntitlementWindowStore())
)
