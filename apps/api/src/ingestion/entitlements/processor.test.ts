import { Ok } from "@unprice/error"
import {
  DO_IDEMPOTENCY_TTL_MS,
  EventTimestampTooFarInFutureError,
  LATE_EVENT_GRACE_MS,
  MAX_FUTURE_EVENT_SKEW_MS,
  deriveMeterKey,
} from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import { createDeferred } from "../test-fixtures/race"
import { FLUSH_INTERVAL_MS } from "./constants"
import type { ApplyInput, ApplyResult } from "./contracts"
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
import { createEntitlementWindowWalletHarness } from "./testing/wallet-harness"

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

const createWalletHarness = createEntitlementWindowWalletHarness

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
    expect(first.meterFacts?.[0]).toMatchObject({
      billing_period_id: "bp_123",
      delta: 3,
      value_after: 3,
    })

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
    // initialize() arms the retention alarm; a rejected apply must not move it.
    const retentionAlarmAt = harness.getAlarmAt()
    const malformedInput = {
      ...createLiveApplyInput(now),
      walletMode: "external_reservation",
      externalReservation: { remainingAmount: 100_000_000 },
    } as unknown as ApplyInput

    await expect(harness.processor.apply(malformedInput)).rejects.toThrow()
    expect(harness.store.idempotency.size).toBe(0)
    expect(harness.store.meterStates.size).toBe(0)
    expect(harness.store.grantStates.size).toBe(0)
    expect(harness.getAlarmAt()).toBe(retentionAlarmAt)
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
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 6, 15))

    try {
      const nowDate = new Date()
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
    } finally {
      vi.useRealTimers()
    }
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

  it("bootstraps a priced single event before the apply engine rejects its timestamp", async () => {
    const wallet = createWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const eventTimestamp = BASE_NOW + MAX_FUTURE_EVENT_SKEW_MS + 60_000
    const input = createApplyInput({
      creditLinePolicy: "capped",
      periodEndAt: eventTimestamp + 60_000,
      event: { timestamp: eventTimestamp },
    })

    await expect(harness.processor.apply(input)).rejects.toThrow(EventTimestampTooFarInFutureError)

    expect(wallet.createReservation).toHaveBeenCalledOnce()
    expect(store.walletRow?.reservationId).toBe("res_test")
  })
})

describe("EntitlementWindowProcessor batch behavior", () => {
  it("matches sequential priced facts", async () => {
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
  })

  it("meters a repeated idempotency key only once within the same batch", async () => {
    const now = BASE_NOW
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now, store })
    await harness.processor.initialize()
    const base = createApplyInput({ creditLinePolicy: "uncapped" })
    const repeatedKey = {
      ...createBatchInput(base, [1, 1], "duplicate"),
      events: createBatchInput(base, [1, 1], "duplicate").events.map((event) => ({
        ...event,
        idempotencyKey: "idem_repeated_in_batch",
      })),
    }
    const result = await harness.processor.applyBatch(repeatedKey)

    expect(result.results[0]).toMatchObject({
      allowed: true,
      correlationKey: "duplicate_0",
      idempotencyKey: "idem_repeated_in_batch",
    })
    expect(result.results[0]?.idempotencyStatus).toBeUndefined()
    expect(result.results[0]?.meterFacts).toHaveLength(1)
    expect(result.results[1]).toMatchObject({
      allowed: true,
      correlationKey: "duplicate_1",
      idempotencyKey: "idem_repeated_in_batch",
      idempotencyStatus: "already_reported",
    })
    expect(result.results[1]?.meterFacts).toEqual(result.results[0]?.meterFacts)
    expect(store.idempotency.size).toBe(1)
    expect(store.meterStates.values().next().value?.usage).toBe(1)
    expect(store.grantStates.values().next().value?.consumedInCurrentWindow).toBe(1)
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
    const reservationResult =
      createDeferred<Awaited<ReturnType<EntitlementWindowWalletOps["createReservation"]>>>()
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

    reservationResult.resolve(
      Ok({ reservationId: "res_concurrent_bootstrap", allocationAmount: 1_000_000_000 })
    )
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
    const wallet = createWalletHarness({ createError: "WALLET_LEDGER_FAILED" })
    const store = new InMemoryEntitlementWindowStore()
    const harness = createHarness({ now: BASE_NOW, store, wallet: wallet.provider })
    await harness.processor.initialize()

    await expect(
      harness.processor.apply(createApplyInput({ creditLinePolicy: "capped" }))
    ).rejects.toThrow("WALLET_LEDGER_FAILED")
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
    { failure: "capture", overrides: { captureError: "WALLET_LEDGER_FAILED" as const } },
    { failure: "extend", overrides: { extendError: "WALLET_LEDGER_FAILED" as const } },
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

  it("rejects corrections that require reversing captured wallet consumption", async () => {
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
    const rejected = await harness.processor.apply(
      createApplyInput({
        creditLinePolicy: "capped",
        idempotencyKey: "idem_negative_correction",
        event: { id: "evt_negative_correction", properties: { amount: -10 } },
      })
    )

    expect(rejected).toMatchObject({
      allowed: false,
      deniedReason: "INVALID_AGGREGATION_PROPERTIES",
    })
    expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([4])
    expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual([
      4,
    ])
    expect(store.walletRow?.consumedAmount).toBe(400_000_000)
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
    expect(harness.instrumentationCalls).toContainEqual({
      operation: "flush_refill",
      baseFields: {
        flush_seq: 1,
        flush_amount: 300_000_000,
        flush_quantity: 3,
        reservation_refill_requested_amount: 0,
      },
    })
    expect(harness.instrumentationCalls.slice(-2).map(({ operation }) => operation)).toEqual([
      "flush_reservation_for_invoicing",
      "flush_refill",
    ])

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
    ).resolves.toMatchObject({
      usage: 0,
      limit: 5,
      isLimitReached: false,
      quotaWindow: {
        periodKey: `onetime:${now - 60_000}`,
        startAt: now - 60_000,
        endAt: now + 60_000,
      },
    })

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
    ).resolves.toMatchObject({
      usage: 3,
      limit: 5,
      isLimitReached: false,
      quotaWindow: {
        periodKey: `onetime:${now - 60_000}`,
        startAt: now - 60_000,
        endAt: now + 60_000,
      },
    })
  })

  it("represents an open-ended quota window without an internal infinity sentinel", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now })
    await harness.processor.initialize()
    const input = createApplyInput({
      grants: [
        createGrantSnapshot({
          cadenceExpiresAt: null,
          expiresAt: null,
        }),
      ],
      limit: 5,
    })

    const state = await harness.processor.getEnforcementState({
      entitlement: input.entitlement,
      grants: input.grants,
      now,
    })

    expect(state.quotaWindow).toEqual({
      periodKey: `onetime:${now - 60_000}`,
      startAt: now - 60_000,
      endAt: null,
    })
  })

  it("omits a singular quota window when active grants reset at different boundaries", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now })
    await harness.processor.initialize()
    const input = createApplyInput({
      grants: [
        createGrantSnapshot({
          allowanceUnits: 2,
          grantId: "grant_first",
        }),
        createGrantSnapshot({
          allowanceUnits: 3,
          cadenceEffectiveAt: now - 30_000,
          effectiveAt: now - 30_000,
          grantId: "grant_second",
        }),
      ],
      limit: 5,
    })

    await expect(
      harness.processor.getEnforcementState({
        entitlement: input.entitlement,
        grants: input.grants,
        now,
      })
    ).resolves.toMatchObject({ quotaWindow: null })
  })

  it("keeps non-subscription meter facts valid without a billing period", async () => {
    const now = BASE_NOW
    const harness = createHarness({ now })
    await harness.processor.initialize()
    const input = createApplyInput({ now })
    input.entitlement.billingPeriods = []

    const result = await harness.processor.apply(input)

    expect(result.meterFacts?.[0]).toMatchObject({ billing_period_id: null })
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

  it("arms a prompt lifecycle alarm on a window that has none", async () => {
    const harness = createHarness({ now: BASE_NOW, store: new InMemoryEntitlementWindowStore() })

    await harness.processor.initialize()

    expect(harness.getAlarmAt()).toBe(BASE_NOW + FLUSH_INTERVAL_MS)
  })

  it("repairs a missing alarm for a live reservation before its deadline", async () => {
    let now = BASE_NOW
    const store = new InMemoryEntitlementWindowStore()
    seedWallet(store)
    const harness = createHarness({ now: () => now, store })

    await harness.processor.initialize()
    expect(harness.getAlarmAt()).toBe(BASE_NOW + FLUSH_INTERVAL_MS)

    now += FLUSH_INTERVAL_MS
    await harness.processor.alarm()

    expect(harness.getAlarmAt()).toBe(BASE_NOW + 60_000)
  })

  it("uses the newest durable write as the retention deadline", async () => {
    const lifecycleEndAt = BASE_NOW
    const lastActivityAt = BASE_NOW + 60_000
    let now = lastActivityAt
    const store = new InMemoryEntitlementWindowStore()
    store.grantStates.set("grant_1:period_1", {
      bucketKey: "grant_1:period_1",
      consumedInCurrentWindow: 1,
      exhaustedAt: null,
      grantId: "grant_1",
      periodEndAt: lifecycleEndAt,
      periodKey: "period_1",
      periodStartAt: lifecycleEndAt - 60_000,
    })
    store.idempotency.set("idem_recent", {
      eventId: "idem_recent",
      createdAt: lastActivityAt,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
      meterFacts: [],
    })
    const harness = createHarness({ now: () => now, store })
    await harness.processor.initialize()

    now = lifecycleEndAt + DO_IDEMPOTENCY_TTL_MS + 1
    await harness.processor.alarm()

    expect(harness.wasDestroyed()).toBe(false)
    expect(store.idempotency.has("idem_recent")).toBe(true)
    expect(harness.getAlarmAt()).toBe(lastActivityAt + DO_IDEMPOTENCY_TTL_MS)
  })

  it("destroys a window that never recorded any state", async () => {
    const harness = createHarness({ now: BASE_NOW, store: new InMemoryEntitlementWindowStore() })
    await harness.processor.initialize()

    await harness.processor.alarm()

    expect(harness.wasDestroyed()).toBe(true)
  })

  it("destroys an idle window one retention period after its last write", async () => {
    const store = new InMemoryEntitlementWindowStore()
    // Meter state only: no grant period and no reservation, so the window has
    // no lifecycle deadline and falls back to its own last write.
    store.meterStates.set("meter_1", { usage: 5, updatedAt: BASE_NOW, createdAt: BASE_NOW })
    let now = BASE_NOW
    const harness = createHarness({ now: () => now, store })
    await harness.processor.initialize()

    now = BASE_NOW + FLUSH_INTERVAL_MS
    await harness.processor.alarm()

    expect(harness.wasDestroyed()).toBe(false)
    expect(harness.getAlarmAt()).toBe(BASE_NOW + DO_IDEMPOTENCY_TTL_MS)

    now = BASE_NOW + DO_IDEMPOTENCY_TTL_MS + 1
    await harness.processor.alarm()

    expect(harness.wasDestroyed()).toBe(true)
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
    expect(harness.instrumentationCalls.map(({ operation }) => operation)).toEqual([
      "alarm",
      "alarm",
      "close_reservation",
    ])
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
    expect(harness.instrumentationCalls).toEqual([
      { operation: "alarm" },
      {
        operation: "flush_refill",
        baseFields: {
          flush_seq: 3,
          flush_amount: 595_600_000,
          flush_quantity: 12,
          reservation_refill_requested_amount: 0,
        },
      },
    ])
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
    expect(harness.instrumentationCalls).toEqual([{ operation: "close_reservation" }])
  })

  it("leaves a failed final flush for operator recovery", async () => {
    const wallet = createWalletHarness({ releaseError: "WALLET_LEDGER_FAILED" })
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
    expect(harness.instrumentationCalls).toEqual([
      {
        operation: "flush_refill",
        baseFields: {
          flush_seq: 1,
          flush_amount: 300_000_000,
          flush_quantity: 3,
          reservation_refill_requested_amount: 200_000_000,
        },
      },
    ])
  })
})

describeEntitlementWindowProcessorContract(
  "EntitlementWindowProcessor (in-memory store contract)",
  createEntitlementWindowStoreContractHostFactory(() => new InMemoryEntitlementWindowStore())
)

describe("reset-scoped aggregation correctness", () => {
  it.each([
    ["max", "single"],
    ["max", "batch"],
    ["latest", "single"],
    ["latest", "batch"],
  ] as const)(
    "isolates %s state across daily resets through %s apply",
    async (aggregationMethod, mode) => {
      const dayStart = Date.UTC(2026, 9, 27)
      const now = dayStart + 100
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: dayStart - 86_400_000,
          periodEndAt: dayStart + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          meterConfig: {
            aggregationField: "amount",
            aggregationMethod,
            eventId: "daily-meter",
            eventSlug: "tokens_used",
          },
        })
        const events = [
          { amount: 10, timestamp: dayStart - 100 },
          { amount: 6, timestamp: dayStart + 1 },
          { amount: 12, timestamp: dayStart - 1 },
          { amount: 8, timestamp: dayStart + 2 },
        ].map(({ amount, timestamp }, index) => ({
          ...base.event,
          properties: { amount },
          timestamp,
          id: `reset-event-${index}`,
          idempotencyKey: `reset-key-${index}`,
          correlationKey: `reset-${index}`,
          now,
        }))
        const results: ApplyResult[] = []
        if (mode === "batch") {
          results.push(
            ...(
              await harness.processor.applyBatch({
                customerId: base.customerId,
                projectId: base.projectId,
                entitlement: base.entitlement,
                enforceLimit: base.enforceLimit,
                grants: base.grants,
                events,
              })
            ).results
          )
        } else {
          for (const event of events) {
            results.push(
              await harness.processor.apply({
                ...base,
                idempotencyKey: event.idempotencyKey,
                event,
              })
            )
          }
        }
        expect(
          results.map((result) =>
            result.meterFacts?.map((fact) => ({
              delta: fact.delta,
              valueAfter: fact.value_after,
              amount: fact.amount,
              periodKey: fact.period_key,
            }))
          )
        ).toEqual([
          [
            {
              delta: 10,
              valueAfter: 10,
              amount: 1_000_000_000,
              periodKey: `day:${dayStart - 86_400_000}`,
            },
          ],
          [{ delta: 6, valueAfter: 6, amount: 600_000_000, periodKey: `day:${dayStart}` }],
          [
            {
              delta: 2,
              valueAfter: 12,
              amount: 200_000_000,
              periodKey: `day:${dayStart - 86_400_000}`,
            },
          ],
          [{ delta: 2, valueAfter: 8, amount: 200_000_000, periodKey: `day:${dayStart}` }],
        ])
        await expect(
          harness.processor.getEnforcementState({
            entitlement: base.entitlement,
            grants: base.grants,
            now,
          })
        ).resolves.toMatchObject({ usage: 8 })
        const lateEvent = events[2]
        if (!lateEvent) throw new Error("Expected a late prior-period event")
        const replay = await harness.processor.apply({
          ...base,
          event: lateEvent,
          idempotencyKey: lateEvent.idempotencyKey,
        })
        expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
        expect(
          [...harness.store.grantStates.values()]
            .map((state) => state.consumedInCurrentWindow)
            .sort((a, b) => a - b)
        ).toEqual([8, 12])
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe("legacy reset meter migration", () => {
  it.each([
    ["sum", -4, 4, "single"],
    ["sum", -4, 4, "batch"],
    ["max", 10, 6, "single"],
    ["max", 10, 6, "batch"],
    ["latest", 10, 6, "single"],
    ["latest", 10, 6, "batch"],
  ] as const)(
    "rejects unknown legacy %s state %s before applying %s through %s",
    async (aggregationMethod, legacyUsage, amount, mode) => {
      const now = Date.UTC(2026, 9, 27, 12)
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: now - 86_400_000,
          periodEndAt: now + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          meterConfig: {
            aggregationField: "amount",
            aggregationMethod,
            eventId: "legacy-meter",
            eventSlug: "tokens_used",
          },
          event: { timestamp: now, properties: { amount } },
        })
        harness.store.meterStates.set(deriveMeterKey(base.entitlement.meterConfig), {
          usage: legacyUsage,
          updatedAt: now - 1,
          createdAt: now - 86_400_000,
        })
        const metersBefore = structuredClone(harness.store.meterStates)
        const command =
          mode === "single"
            ? harness.processor.apply(base)
            : harness.processor.applyBatch(createBatchInput(base, [amount], "legacy-unknown"))
        await expect(command).rejects.toThrow(
          "Legacy meter state overlaps this reset period. Reconcile historical usage before recording new events in this period."
        )
        expect(harness.store.meterStates).toEqual(metersBefore)
        expect(harness.store.grantStates.size).toBe(0)
        expect(harness.store.idempotency.size).toBe(0)
        expect(harness.store.walletRow).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(["max", "latest"] as const)(
    "starts a new %s period after the legacy watermark at zero",
    async (aggregationMethod) => {
      const dayStart = Date.UTC(2026, 9, 27)
      const now = dayStart + 10
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: dayStart - 86_400_000,
          periodEndAt: dayStart + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          meterConfig: {
            aggregationField: "amount",
            aggregationMethod,
            eventId: "legacy-meter",
            eventSlug: "tokens_used",
          },
          event: { timestamp: now, properties: { amount: 6 } },
        })
        harness.store.meterStates.set(deriveMeterKey(base.entitlement.meterConfig), {
          usage: 10,
          updatedAt: dayStart - 1,
          createdAt: dayStart - 86_400_000,
        })
        const result = await harness.processor.apply(base)
        expect(
          result.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
        ).toEqual([[6, 6, 600_000_000]])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(["single", "batch"] as const)(
    "replays a sealed legacy receipt through %s without initializing reset state",
    async (mode) => {
      const now = Date.UTC(2026, 9, 27, 12)
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: now - 86_400_000,
          periodEndAt: now + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          event: { timestamp: now, properties: { amount: 3 } },
        })
        const accepted = await harness.processor.apply(base)
        harness.store.meterStates.clear()
        harness.store.meterStates.set(deriveMeterKey(base.entitlement.meterConfig), {
          usage: 3,
          updatedAt: now,
          createdAt: now - 86_400_000,
        })
        const input = createBatchInput(base, [3], "legacy-replay")
        const event = input.events[0]
        if (!event) throw new Error("Expected replay event")
        const replay =
          mode === "single"
            ? await harness.processor.apply(base)
            : (
                await harness.processor.applyBatch({
                  ...input,
                  events: [
                    { ...event, idempotencyKey: base.idempotencyKey },
                    { ...event, idempotencyKey: base.idempotencyKey },
                  ],
                })
              ).results[1]
        expect(replay).toMatchObject({
          allowed: true,
          idempotencyStatus: "already_reported",
          meterFacts: accepted.meterFacts,
        })
        expect([...harness.store.meterStates.keys()]).toEqual([
          deriveMeterKey(base.entitlement.meterConfig),
        ])
        expect(
          [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
        ).toEqual([3])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("replays a staged duplicate before reading its legacy period", async () => {
    const dayStart = Date.UTC(2026, 9, 27)
    const now = dayStart + 10
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        periodStartAt: dayStart - 86_400_000,
        periodEndAt: dayStart + 86_400_000,
        resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
        event: { timestamp: now },
      })
      harness.store.meterStates.set(deriveMeterKey(base.entitlement.meterConfig), {
        usage: 10,
        updatedAt: dayStart - 1,
        createdAt: dayStart - 86_400_000,
      })
      const input = createBatchInput(base, [6], "staged-legacy-replay")
      const first = input.events[0]
      if (!first) throw new Error("Expected new-period event")
      const result = await harness.processor.applyBatch({
        ...input,
        events: [first, { ...first, timestamp: dayStart - 1 }],
      })
      expect(
        result.results[0]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[6, 6, 600_000_000]])
      expect(result.results[1]).toMatchObject({
        allowed: true,
        idempotencyStatus: "already_reported",
        meterFacts: result.results[0]?.meterFacts,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("legacy closed-period batch handling", () => {
  it("accepts the new period and denies a closed legacy event before reading its raw state", async () => {
    const dayStart = Date.UTC(2026, 9, 27)
    const now = dayStart + LATE_EVENT_GRACE_MS + 1
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        periodStartAt: dayStart - 86_400_000,
        periodEndAt: dayStart + 86_400_000,
        resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
        event: { timestamp: now },
      })
      harness.store.meterStates.set(deriveMeterKey(base.entitlement.meterConfig), {
        usage: -4,
        updatedAt: dayStart - 1,
        createdAt: dayStart - 86_400_000,
      })
      const input = createBatchInput(base, [4, 1], "closed-legacy")
      const fresh = input.events[0]
      const closed = input.events[1]
      if (!fresh || !closed) throw new Error("Expected fresh and closed events")
      const result = await harness.processor.applyBatch({
        ...input,
        events: [fresh, { ...closed, timestamp: dayStart - 1 }],
      })
      expect(
        result.results[0]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[4, 4, 400_000_000]])
      expect(result.results[1]).toMatchObject({
        allowed: false,
        deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      })
      expect(
        [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
      ).toEqual([4])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("grant correction correctness", () => {
  it.each([
    ["sum", "single", false],
    ["sum", "single", true],
    ["sum", "batch", false],
    ["sum", "batch", true],
    ["latest", "single", false],
    ["latest", "single", true],
    ["latest", "batch", false],
    ["latest", "batch", true],
  ] as const)(
    "restores grant capacity for %s through %s with enforcement %s",
    async (aggregationMethod, mode, enforceLimit) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit,
        limit: 10,
        meterConfig: {
          aggregationMethod,
          aggregationField: "amount",
          eventId: "correction-meter",
          eventSlug: "tokens_used",
        },
      })
      const events = (aggregationMethod === "sum" ? [10, -4, 4] : [10, 6, 10]).map(
        (amount, index) => ({
          ...base.event,
          id: `correction-event-${index}`,
          idempotencyKey: `correction-key-${index}`,
          correlationKey: `correction-${index}`,
          properties: { amount },
          timestamp: now + index,
          now: now + index,
        })
      )
      const results: ApplyResult[] = []
      if (mode === "batch") {
        results.push(
          ...(
            await harness.processor.applyBatch({
              customerId: base.customerId,
              projectId: base.projectId,
              entitlement: base.entitlement,
              enforceLimit,
              grants: base.grants,
              events,
            })
          ).results
        )
      } else {
        for (const event of events) {
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
        }
      }
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => ({
            delta: fact.delta,
            value: fact.value_after,
            amount: fact.amount,
          }))
        )
      ).toEqual([
        [{ delta: 10, value: 10, amount: 1_000_000_000 }],
        [{ delta: -4, value: 6, amount: -400_000_000 }],
        [{ delta: 4, value: 10, amount: 400_000_000 }],
      ])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10, limit: 10, isLimitReached: true })
      const correction = events[1]
      if (!correction) throw new Error("Expected correction event")
      const replay = await harness.processor.apply({
        ...base,
        event: correction,
        idempotencyKey: correction.idempotencyKey,
        now: correction.now,
      })
      expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
      expect(
        [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
      ).toEqual([10])
    }
  )

  it.each(["single", "batch"] as const)(
    "reverses consumption across multiple grants through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit: true,
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const events = createBatchInput(base, [10, -7, 7], "multiple-correction").events
      const results: ApplyResult[] = []
      if (mode === "batch") {
        results.push(
          ...(
            await harness.processor.applyBatch({ ...createBatchInput(base, [], "unused"), events })
          ).results
        )
      } else {
        for (const event of events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      }
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results[1]?.meterFacts?.map((fact) => ({
          grant: fact.grant_id,
          delta: fact.delta,
          value: fact.value_after,
          amount: fact.amount,
        }))
      ).toEqual([
        { grant: "grant_second", delta: -4, value: 0, amount: -400_000_000 },
        { grant: "grant_first", delta: -3, value: 3, amount: -300_000_000 },
      ])
      expect(
        [...harness.store.grantStates.values()].map((state) => ({
          grant: state.grantId,
          usage: state.consumedInCurrentWindow,
        }))
      ).toEqual([
        { grant: "grant_first", usage: 6 },
        { grant: "grant_second", usage: 4 },
      ])
    }
  )

  it.each(["single", "batch"] as const)(
    "preserves signed raw totals and floor-zero billable usage through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({ now, enforceLimit: true, limit: 10 })
      const input = createBatchInput(base, [10, -14, 4, 3], "over-correction")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(results.map((result) => result.allowed)).toEqual([true, true, true, true])
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => ({
            delta: fact.delta,
            value: fact.value_after,
            amount: fact.amount,
          }))
        )
      ).toEqual([
        [{ delta: 10, value: 10, amount: 1_000_000_000 }],
        [{ delta: -10, value: 0, amount: -1_000_000_000 }],
        [{ delta: 0, value: 0, amount: 0 }],
        [{ delta: 3, value: 3, amount: 300_000_000 }],
      ])
      expect([...harness.store.meterStates.values()].map((state) => state.usage)).toEqual([3])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 3, limit: 10, isLimitReached: false })
    }
  )
})

describe("correction accounting boundaries", () => {
  it.each(["single", "batch"] as const)(
    "keeps unchanged max snapshots per grant through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        meterConfig: {
          aggregationMethod: "max",
          aggregationField: "amount",
          eventId: "max-grants",
          eventSlug: "tokens_used",
        },
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const input = createBatchInput(base, [10, 8], "unchanged-max")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(results[0]?.meterFacts?.map((fact) => [fact.grant_id, fact.value_after])).toEqual([
        ["grant_first", 6],
        ["grant_second", 4],
      ])
      expect(
        results[1]?.meterFacts?.map((fact) => [
          fact.grant_id,
          fact.delta,
          fact.value_after,
          fact.amount,
        ])
      ).toEqual([["grant_first", 0, 6, 0]])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10 })
    }
  )

  it.each(["single", "batch"] as const)(
    "rejects a correction below captured spend atomically through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        limit: 10,
        enforceLimit: true,
        creditLinePolicy: "capped",
      })
      const positive = createBatchInput(base, [10], "captured-positive").events[0]
      if (!positive) throw new Error("Expected positive event")
      await harness.processor.apply({
        ...base,
        event: positive,
        idempotencyKey: positive.idempotencyKey,
        now: positive.now,
      })
      store.updateWalletReservation({ flushedAmount: 700_000_000, flushedQuantity: 7 })
      const input = createBatchInput(base, [-4], "captured-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction event")
      const before = {
        meters: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const rejected =
        mode === "batch"
          ? (await harness.processor.applyBatch(input)).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: correction.now,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
        message:
          "Correction would reverse committed wallet consumption. Use a separate credit workflow for captured usage.",
      })
      expect(store.meterStates).toEqual(before.meters)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
      const replay = await harness.processor.apply({
        ...base,
        event: correction,
        idempotencyKey: correction.idempotencyKey,
        now: correction.now,
      })
      expect(replay).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
        idempotencyStatus: "already_reported",
      })
      const valid = {
        ...correction,
        id: "valid-captured-correction",
        idempotencyKey: "valid-captured-correction",
        properties: { amount: -3 },
      }
      const accepted =
        mode === "batch"
          ? (await harness.processor.applyBatch({ ...input, events: [valid] })).results[0]
          : await harness.processor.apply({
              ...base,
              event: valid,
              idempotencyKey: valid.idempotencyKey,
              now: valid.now,
            })
      expect(accepted).toMatchObject({ allowed: true })
      expect(
        accepted?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[-3, 7, -300_000_000]])
      expect(store.walletRow).toMatchObject({
        consumedAmount: 700_000_000,
        consumedQuantity: 7,
        flushedAmount: 700_000_000,
      })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([7])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 7, isLimitReached: false })
    }
  )

  it.each(["single", "batch"] as const)(
    "applies unflushed corrections without changing net wallet spend through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        limit: 10,
        enforceLimit: true,
        creditLinePolicy: "capped",
      })
      const input = createBatchInput(base, [10, -4, 4], "unflushed-correction")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results.flatMap((result) => result.meterFacts ?? []).map((fact) => fact.amount)
      ).toEqual([1_000_000_000, -400_000_000, 400_000_000])
      expect(store.walletRow).toMatchObject({ consumedAmount: 1_000_000_000, flushedAmount: 0 })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([10])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10 })
    }
  )

  it("keeps accepted batch events when a later correction is rejected", async () => {
    const now = BASE_NOW
    const wallet = createWalletHarness()
    const harness = createHarness({ now, wallet: wallet.provider })
    const store = harness.store
    seedWallet(store, {
      allocationAmount: 1_000_000_000_000,
      targetReservationAmount: 1_000_000_000_000,
    })
    await harness.processor.initialize()
    const base = createApplyInput({ now, creditLinePolicy: "capped" })
    const first = createBatchInput(base, [10], "mixed-first").events[0]
    if (!first) throw new Error("Expected first event")
    await harness.processor.apply({
      ...base,
      event: first,
      idempotencyKey: first.idempotencyKey,
      now: first.now,
    })
    store.updateWalletReservation({ flushedAmount: 700_000_000, flushedQuantity: 7 })
    const input = createBatchInput(base, [1, -5, -4], "mixed-correction")
    const result = await harness.processor.applyBatch(input)
    expect(result.results.map((row) => row.allowed)).toEqual([true, false, true])
    expect(result.results[1]).toMatchObject({ deniedReason: "INVALID_AGGREGATION_PROPERTIES" })
    expect(
      result.results[2]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
    ).toEqual([[-4, 7, -400_000_000]])
    expect(store.walletRow).toMatchObject({
      consumedAmount: 700_000_000,
      flushedAmount: 700_000_000,
    })
    expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([7])
    expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual([
      7,
    ])
  })
})

describe("overage correction allocation", () => {
  it.each(["single", "batch"] as const)(
    "reverses overflow before included capacity and publishes one snapshot per grant through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit: false,
        overageStrategy: "always",
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const input = createBatchInput(base, [15, -3, -5, -6], "overage-correction")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => [
            fact.grant_id,
            fact.delta,
            fact.value_after,
            fact.amount,
          ])
        )
      ).toEqual([
        [
          ["grant_first", 11, 11, 1_100_000_000],
          ["grant_second", 4, 4, 400_000_000],
        ],
        [["grant_first", -3, 8, -300_000_000]],
        [
          ["grant_first", -2, 6, -200_000_000],
          ["grant_second", -3, 1, -300_000_000],
        ],
        [
          ["grant_second", -1, 0, -100_000_000],
          ["grant_first", -5, 1, -500_000_000],
        ],
      ])
      for (const result of results) {
        const identities =
          result.meterFacts?.map((fact) =>
            [
              fact.customer_entitlement_id,
              fact.grant_id,
              fact.period_key,
              fact.idempotency_key,
            ].join("|")
          ) ?? []
        expect(new Set(identities).size).toBe(identities.length)
      }
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 1 })
    }
  )
})

describe("pending wallet capture correction boundary", () => {
  it.each(["single", "batch"] as const)(
    "rejects a correction below a persisted pending capture through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({ now, creditLinePolicy: "capped" })
      const initial = createBatchInput(base, [10], "pending-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      store.updateWalletReservation({
        flushedAmount: 700_000_000,
        flushedQuantity: 7,
        flushSeq: 0,
        pendingFlushSeq: 1,
        pendingFlushAmount: 200_000_000,
        pendingFlushQuantity: 2,
        pendingFlushFinal: false,
        refillInFlight: true,
      })
      const before = {
        meter: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const input = createBatchInput(base, [-2], "pending-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const rejected =
        mode === "batch"
          ? (await harness.processor.applyBatch(input)).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: correction.now,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect(store.meterStates).toEqual(before.meter)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
    }
  )
})

describe("closed wallet reservation correction boundary", () => {
  it.each(["single", "batch"] as const)(
    "rejects reversing usage captured by a closed reservation through %s",
    async (mode) => {
      let clock = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now: () => clock, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({ now: BASE_NOW, creditLinePolicy: "capped" })
      const initial = createBatchInput(base, [10], "closed-wallet-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      await Promise.all(harness.waitUntilPromises)
      clock = BASE_NOW + 60_001
      await harness.processor.alarm()
      expect(store.walletRow).toMatchObject({
        reservationId: null,
        consumedAmount: 1_000_000_000,
        flushedAmount: 1_000_000_000,
      })
      const input = createBatchInput(base, [-1], "closed-wallet-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const rejected =
        mode === "batch"
          ? (
              await harness.processor.applyBatch({
                ...input,
                events: [{ ...correction, now: clock }],
              })
            ).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: clock,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([10])
      expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual(
        [10]
      )
      expect(store.walletRow).toMatchObject({
        reservationId: null,
        consumedAmount: 1_000_000_000,
        flushedAmount: 1_000_000_000,
      })
    }
  )
})

describe("zero-price committed quantity correction boundary", () => {
  it.each([
    ["single", "captured"],
    ["batch", "captured"],
    ["single", "pending"],
    ["batch", "pending"],
    ["single", "closed"],
    ["batch", "closed"],
  ] as const)(
    "rejects a zero-cost correction through %s below %s quantity",
    async (mode, commitment) => {
      let clock = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now: () => clock, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now: BASE_NOW,
        creditLinePolicy: "capped",
        priceConfig: {
          usageMode: "unit",
          price: {
            dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
            displayAmount: "0.00",
          },
        },
      })
      const initial = createBatchInput(base, [10], "free-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      await Promise.all(harness.waitUntilPromises)
      expect(store.walletRow).toMatchObject({ consumedAmount: 0, consumedQuantity: 10 })
      if (commitment === "closed") {
        clock = BASE_NOW + 60_001
        await harness.processor.alarm()
        expect(store.walletRow).toMatchObject({
          reservationId: null,
          flushedAmount: 0,
          flushedQuantity: 10,
        })
      } else if (commitment === "pending") {
        store.updateWalletReservation({
          flushedAmount: 0,
          flushedQuantity: 7,
          flushSeq: 0,
          pendingFlushSeq: 1,
          pendingFlushAmount: 0,
          pendingFlushQuantity: 2,
          pendingFlushFinal: false,
          refillInFlight: true,
        })
      } else store.updateWalletReservation({ flushedAmount: 0, flushedQuantity: 7 })
      const before = {
        meters: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const input = createBatchInput(base, [commitment === "pending" ? -2 : -4], "free-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const result =
        mode === "batch"
          ? (
              await harness.processor.applyBatch({
                ...input,
                events: [{ ...correction, now: clock }],
              })
            ).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: clock,
            })
      expect(result).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect(store.meterStates).toEqual(before.meters)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
    }
  )
})
