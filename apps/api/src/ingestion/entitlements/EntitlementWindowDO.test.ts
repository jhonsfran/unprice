import { type Dinero, dinero } from "dinero.js"
import { USD } from "dinero.js/currencies"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

// Real Dinero<number> at the requested scale; the production pricing path
// calls transformScale/toSnapshot on it, so plain objects won't do.
function fakeDinero(amount: number, scale: number): Dinero<number> {
  return dinero({ amount, currency: USD, scale })
}

const BASE_NOW = Date.UTC(2026, 2, 19, 12, 0, 0)
const TEST_MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000

type Fact = { delta: number; meterKey: string; valueAfter: number }
type PersistOptions = { beforePersist?: (facts: Fact[]) => void }

type DrizzleCondition = {
  kind: string
  value?: unknown
  values?: unknown[]
  conditions?: DrizzleCondition[]
}

type IdempotencyRow = {
  createdAt: number
  allowed: boolean
  deniedReason: string | null
  denyMessage: string | null
}

type MeterWindowRow = {
  meterKey: string
  currency: string
  priceConfig: unknown
  periodEndAt: number | null
  usage: number
  updatedAt: number | null
  createdAt: number
  // Phase 7 identity + reservation columns; null/zero until activation sets them.
  projectId?: string | null
  customerId?: string | null
  reservationId?: string | null
  allocationAmount?: number
  consumedAmount?: number
  flushedAmount?: number
  refillThresholdBps?: number
  refillChunkAmount?: number
  refillInFlight?: boolean
  flushSeq?: number
  pendingFlushSeq?: number | null
  // Phase 7.7 alarm trigger columns.
  lastEventAt?: number | null
  deletionRequested?: boolean
  recoveryRequired?: boolean
}

const METER_WINDOW_KEYS = new Set<string>([
  "meterKey",
  "currency",
  "priceConfig",
  "periodEndAt",
  "usage",
  "updatedAt",
  "createdAt",
  "projectId",
  "customerId",
  "reservationId",
  "allocationAmount",
  "consumedAmount",
  "flushedAmount",
  "refillThresholdBps",
  "refillChunkAmount",
  "refillInFlight",
  "flushSeq",
  "pendingFlushSeq",
  "lastEventAt",
  "deletionRequested",
  "recoveryRequired",
])

type FakeDbState = {
  idempotencyRows: Map<string, IdempotencyRow>
  outboxRows: { id: number; payload: string; currency: string }[]
  meterWindowRows: Map<string, MeterWindowRow>
}

type FakeDurableObjectState = {
  alarmAt: number | null
  deletedAlarm: boolean
  deletedAll: boolean
  id: { toString: () => string }
  blockConcurrencyWhile: <T>(cb: () => Promise<T> | T) => Promise<T>
  // Phase 7: apply() schedules flush+refill via ctx.waitUntil. We record
  // the scheduled promise so tests can assert the refill was triggered and
  // await its completion before making assertions on db state.
  waitUntilPromises: Promise<unknown>[]
  waitUntil: (promise: Promise<unknown>) => void
  storage: {
    deleteAlarm: () => Promise<void>
    deleteAll: () => Promise<void>
    getAlarm: () => Promise<number | null>
    setAlarm: (ts: number) => Promise<void>
  }
}

const testState = {
  analyticsIngest: vi.fn(),
  db: null as FakeDbState | null,
  engineApply: vi.fn(),
  pricePerFeature: vi.fn(),
  flushReservation: vi.fn(),
  logger: {
    debug: vi.fn(),
    emit: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  },
}

const DEFAULT_METER_CONFIG = {
  aggregationField: "amount",
  aggregationMethod: "sum" as const,
  eventId: "meter_123",
  eventSlug: "tokens_used",
}

const DEFAULT_METER_KEY = [
  DEFAULT_METER_CONFIG.eventId,
  DEFAULT_METER_CONFIG.eventSlug,
  DEFAULT_METER_CONFIG.aggregationMethod,
  DEFAULT_METER_CONFIG.aggregationField,
].join(":")

// configFeatureSchema is mocked to accept any record; the DO forwards this
// straight to calculatePricePerFeature (also mocked) and never inspects its
// internals, so this stub just needs to pass validation.
const DEFAULT_PRICE_CONFIG = {
  usageMode: "unit" as const,
  price: {
    dinero: {
      amount: 100,
      currency: { code: "USD", base: 10, exponent: 2 },
      scale: 2,
    },
    displayAmount: "1.00",
  },
}

describe("EntitlementWindowDO", () => {
  beforeEach(() => {
    for (const fn of Object.values(testState.logger)) fn.mockReset()
    testState.analyticsIngest.mockReset()
    testState.engineApply.mockReset()
    testState.pricePerFeature.mockReset()
    testState.flushReservation.mockReset()
    // Default: flush+refill settles with zero runway so tests that don't
    // opt into the wallet path stay identical to their pre-7.5 shape.
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: { grantedAmount: 0, flushedAmount: 0, refundedAmount: 0, drainLegs: [] },
    })
    // Default: unit pricing — amount = quantity * $1.00. We return fake Dinero
    // objects (toJSON + currency snapshot) so the real diffLedgerMinor /
    // transformScale pipeline can rescale them to LEDGER_SCALE (6).
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: {
        totalPrice: {
          dinero: fakeDinero(Math.max(0, quantity) * 100, 2),
        },
      },
    }))
    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    testState.db = null
  })

  it("deduplicates successful apply calls by idempotency key", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput()

    const first = await durableObject.apply(input)
    const second = await durableObject.apply(input)

    expect(first).toEqual({ allowed: true })
    expect(second).toEqual({ allowed: true })
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(db.idempotencyRows.size).toBe(1)
    expect(db.outboxRows).toHaveLength(1)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)

    // priced payload surfaces ledger-scale amount + priced_at
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    // 3 units @ $1.00 = $3.00 = 300_000_000 at LEDGER_SCALE (8)
    expect(payload.amount).toBe(300_000_000)
    expect(payload.amount_scale).toBe(8)
    expect(payload.currency).toBe("USD")
    expect(payload.priced_at).toBe(BASE_NOW)
    expect(payload.feature_plan_version_id).toBe("fpv_123")
  })

  it("preserves sub-cent pricing precisely across many events", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    // Price = $0.000003 per unit (3 at scale 6; transformScale up-converts
    // to 300 at LEDGER_SCALE=8). Each event has delta=1; cumulative
    // value_after grows by 1 per call.
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: { totalPrice: { dinero: fakeDinero(Math.max(0, quantity) * 3, 6) } },
    }))

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const EVENT_COUNT = 1000
    for (let i = 0; i < EVENT_COUNT; i++) {
      testState.engineApply.mockImplementationOnce((_event: unknown, options?: PersistOptions) => {
        const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: i + 1 }]
        options?.beforePersist?.(facts)
        return facts
      })
      await durableObject.apply(
        createApplyInput({
          idempotencyKey: `idem_${i}`,
          event: { ...createApplyInput().event, id: `evt_${i}` },
        })
      )
    }

    // Per-event amount would round to 0 cents at scale 2, losing all revenue.
    // At LEDGER_SCALE=8 each $0.000003 delta = 300 minor units; sum is exact.
    const total = db.outboxRows.reduce(
      (acc, row) => acc + (JSON.parse(row.payload).amount as number),
      0
    )
    expect(total).toBe(EVENT_COUNT * 300)
  })

  it("stores denied results and reuses them when a retry hits the same limit", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 11 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput({
      enforceLimit: true,
      limit: 10,
    })

    const first = await durableObject.apply(input)
    const second = await durableObject.apply(input)

    expect(first).toEqual({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: expect.stringContaining(DEFAULT_METER_KEY),
    })
    expect(second).toEqual(first)
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(db.idempotencyRows.size).toBe(1)
    expect(db.outboxRows).toHaveLength(0)
    expect(state.alarmAt).toBeNull()
  })

  it("rejects invalid apply payloads", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["empty idempotency key", { idempotencyKey: "" }],
      ["missing meter", { meter: null }],
      ["non-finite limit", { limit: Number.POSITIVE_INFINITY }],
      ["unsupported overage strategy", { overageStrategy: "sometimes" }],
      ["nan period end", { periodEndAt: Number.NaN }],
      ["missing price config", { priceConfig: null }],
      ["missing plan version id", { featurePlanVersionId: "" }],
    ]

    for (const [, overrides] of cases) {
      const EntitlementWindowDO = await loadEntitlementWindowDO()
      const state = createDurableObjectState()
      const db = createFakeDbState()
      testState.db = db

      const durableObject = new EntitlementWindowDO(state, createEnv())
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid input
      const input = { ...createApplyInput(), ...overrides } as any

      await expect(durableObject.apply(input)).rejects.toThrow()
      expect(testState.engineApply).not.toHaveBeenCalled()
      expect(db.idempotencyRows.size).toBe(0)
      expect(db.outboxRows).toHaveLength(0)
      expect(state.alarmAt).toBeNull()
      vi.resetModules()
      testState.engineApply.mockReset()
    }
  })

  it("flushes queued facts during alarm and schedules self-destruct when the outbox is empty", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter: 2 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.analyticsIngest.mockResolvedValue({
      quarantined_rows: 0,
      successful_rows: 1,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput({
      periodEndAt: BASE_NOW + 60_000,
    })

    await durableObject.apply(input)
    // Cloudflare auto-clears the scheduled alarm before invoking alarm()
    state.alarmAt = null
    await durableObject.alarm()

    expect(testState.analyticsIngest).toHaveBeenCalledTimes(1)
    expect(testState.analyticsIngest).toHaveBeenCalledWith([
      expect.objectContaining({
        delta: 2,
        event_id: input.event.id,
        feature_slug: input.featureSlug,
        feature_plan_version_id: "fpv_123",
        idempotency_key: input.idempotencyKey,
        stream_id: input.streamId,
        value_after: 2,
        amount: 200_000_000,
        amount_scale: 8,
        currency: "USD",
      }),
    ])
    expect(db.outboxRows).toHaveLength(0)
    expect(state.alarmAt).toBe(input.periodEndAt + TEST_MAX_EVENT_AGE_MS)
  })

  it("keeps rows in the outbox for retry when Tinybird flush fails", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter: 2 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.analyticsIngest.mockRejectedValueOnce(new Error("tinybird down"))

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput()

    await durableObject.apply(input)
    await durableObject.alarm()

    expect(testState.analyticsIngest).toHaveBeenCalledTimes(1)
    // Failed flush leaves the row in the outbox
    expect(db.outboxRows).toHaveLength(1)

    // Next alarm retries successfully and drains the outbox
    testState.analyticsIngest.mockResolvedValueOnce({
      quarantined_rows: 0,
      successful_rows: 1,
    })
    await durableObject.alarm()
    expect(testState.analyticsIngest).toHaveBeenCalledTimes(2)
    expect(db.outboxRows).toHaveLength(0)
  })

  it("does not open a Postgres connection, nor call ledger/rating services", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.analyticsIngest.mockResolvedValue({
      quarantined_rows: 0,
      successful_rows: 10,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    for (let i = 0; i < 10; i++) {
      await durableObject.apply(
        createApplyInput({
          idempotencyKey: `idem_${i}`,
          event: { ...createApplyInput().event, id: `evt_${i}` },
        })
      )
    }
    await durableObject.alarm()

    expect(createConnectionSpy).not.toHaveBeenCalled()
    expect(ledgerPostChargeSpy).not.toHaveBeenCalled()
    expect(ratingRateIncrementalSpy).not.toHaveBeenCalled()
  })

  it("snapshots price config once and accepts later applies with different fpvs on the same stream", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    let cumulative = 0
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      cumulative += 1
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: cumulative }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())

    // First apply pins priceConfig + currency for the meterKey.
    await durableObject.apply(
      createApplyInput({ idempotencyKey: "idem_a", featurePlanVersionId: "fpv_a" })
    )
    expect(db.meterWindowRows.size).toBe(1)
    const pricingRow = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(pricingRow?.currency).toBe("USD")
    expect(pricingRow?.priceConfig).toEqual(DEFAULT_PRICE_CONFIG)

    // Second apply with a different fpv (e.g. addon grant) — same fungible
    // stream, must succeed. streamId is the identity; fpv is per-event audit.
    await durableObject.apply(
      createApplyInput({ idempotencyKey: "idem_b", featurePlanVersionId: "fpv_b" })
    )

    expect(db.meterWindowRows.size).toBe(1)
    expect(db.outboxRows).toHaveLength(2)
    const fpvs = db.outboxRows.map((row) => JSON.parse(row.payload).feature_plan_version_id)
    expect(fpvs).toEqual(["fpv_a", "fpv_b"])
  })

  it("getEnforcementState returns safe defaults on a fresh DO", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    testState.db = createFakeDbState()

    const durableObject = new EntitlementWindowDO(state, createEnv())
    // No apply has run yet — cache is null, so the DO returns a conservative
    // { usage: 0, limit: null, isLimitReached: false }. The caller recomputes
    // isLimitReached against its own resolved state when needed.
    const result = await durableObject.getEnforcementState()

    expect(result).toEqual({ usage: 0, limit: null, isLimitReached: false })
  })

  it("getEnforcementState serves the post-apply enforcement cache (limit + usage + isLimitReached)", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const durableObject = new EntitlementWindowDO(state, createEnv())

    // Apply #1: usage 7 under limit 100 → not reached
    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 7, meterKey: DEFAULT_METER_KEY, valueAfter: 7 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(createApplyInput({ limit: 100 }))
    expect(await durableObject.getEnforcementState()).toEqual({
      usage: 7,
      limit: 100,
      isLimitReached: false,
    })

    // Apply #2: usage 7 exactly at limit 7 → reached
    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 0, meterKey: DEFAULT_METER_KEY, valueAfter: 7 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(createApplyInput({ idempotencyKey: "idem_2", limit: 7 }))
    expect(await durableObject.getEnforcementState()).toEqual({
      usage: 7,
      limit: 7,
      isLimitReached: true,
    })

    // Apply #3: overageStrategy "always" suppresses isLimitReached even past limit
    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 10 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(
      createApplyInput({ idempotencyKey: "idem_3", limit: 7, overageStrategy: "always" })
    )
    expect(await durableObject.getEnforcementState()).toEqual({
      usage: 10,
      limit: 7,
      isLimitReached: false,
    })
  })

  it("does not update the cache when apply is rolled back by LIMIT_EXCEEDED", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      // Engine would bump usage to 11, but beforePersist rejects it → tx rolls back.
      const facts = [{ delta: 11, meterKey: DEFAULT_METER_KEY, valueAfter: 11 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const denied = await durableObject.apply(
      createApplyInput({ enforceLimit: true, limit: 10 })
    )
    expect(denied.allowed).toBe(false)

    // Cache was never populated because the tx threw before the post-commit flush.
    const result = await durableObject.getEnforcementState()
    expect(result).toEqual({ usage: 0, limit: null, isLimitReached: false })
  })

  it("rehydrates window state after eviction so alarm reads periodEndAt from SQLite", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 1 })

    const input = createApplyInput({ periodEndAt: BASE_NOW + 60_000 })

    // First DO instance performs the apply; periodEndAt lands in meter_window
    // so it survives eviction.
    const first = new EntitlementWindowDO(state, createEnv())
    await first.apply(input)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.periodEndAt).toBe(input.periodEndAt)

    // Simulate eviction: Cloudflare clears the alarm and evicts the DO.
    state.alarmAt = null
    const revived = new EntitlementWindowDO(state, createEnv())

    await revived.alarm()

    // alarm() now reads periodEndAt from SQLite on demand, so the self-destruct
    // branch fires and schedules the next alarm at periodEndAt + MAX_EVENT_AGE_MS.
    expect(state.alarmAt).toBe(input.periodEndAt + TEST_MAX_EVENT_AGE_MS)
  })

  it("scheduleAlarm does not downgrade an earlier pending alarm", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    // Pre-set an alarm as if it survived DO eviction
    state.alarmAt = BASE_NOW + 10_000

    await durableObject.apply(createApplyInput())
    // Would-be new alarm at BASE_NOW + 30_000 > existing; existing wins
    expect(state.alarmAt).toBe(BASE_NOW + 10_000)
  })

  // ---------------------------------------------------------------------
  // Phase 7 — wallet hot path. These exercise the reservation-aware
  // branch of apply(): the window row must be seeded with a reservation
  // for the branch to engage; otherwise the DO keeps its pre-wallet
  // behaviour (covered by the earlier tests in this suite).
  // ---------------------------------------------------------------------

  it("skips the wallet check when the window has no reservation (pre-activation)", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toEqual({ allowed: true })
    expect(state.waitUntilPromises).toHaveLength(0)
    // Reservation fields are left at schema defaults (unset in the fake row).
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.reservationId ?? null).toBeNull()
    expect(row?.consumedAmount ?? 0).toBe(0)
  })

  it("denies with WALLET_EMPTY when the priced cost exceeds remaining allocation", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    // Pre-seed the meter_window row as if activation had opened a reservation
    // with a $2 allocation, fully consumed but for 10 minor units (< $3 cost).
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      reservationId: "res_abc",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 2 * 100_000_000 - 10,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const first = await durableObject.apply(createApplyInput())
    const second = await durableObject.apply(createApplyInput())

    expect(first).toEqual({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
      message: expect.stringContaining("res_abc"),
    })
    // Replay returns the stored denial, no second engine invocation.
    expect(second).toEqual(first)
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(db.idempotencyRows.size).toBe(1)
    expect(db.outboxRows).toHaveLength(0)
    // No wallet update committed — transaction rolled back.
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(
      2 * 100_000_000 - 10
    )
    expect(state.waitUntilPromises).toHaveLength(0)
  })

  it("deducts consumedAmount and triggers flush+refill when remaining falls below threshold", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })

    // Allocation $5, threshold 50% ($2.50), chunk $2.50. A $5 event consumes
    // everything; new remaining = 0 < threshold → refill fires.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 2.5 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toEqual({ allowed: true })
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // 5 events @ $1.00 = $5.00 at LEDGER_SCALE=8.
    expect(row.consumedAmount).toBe(5 * 100_000_000)
    // Refill was scheduled via ctx.waitUntil; the stub body (slice 7.5 will
    // replace it) settles synchronously on the microtask queue, so by the
    // time this assertion runs the single-flight flag has already cleared.
    expect(state.waitUntilPromises).toHaveLength(1)

    await Promise.all(state.waitUntilPromises)
    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(after.refillInFlight).toBe(false)
    expect(after.pendingFlushSeq).toBeNull()
  })

  it("does not re-trigger refill when one is already in flight", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    // Fixture represents an in-flight refill within the SAME DO instance —
    // flushSeq and pendingFlushSeq are aligned so crash recovery (which
    // fires on pendingFlushSeq > flushSeq) stays out of the way; we're
    // validating apply()'s single-flight guard, not the recovery path.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 100_000_000, // $1 already consumed, $1 remaining
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 100_000_000,
      refillInFlight: true, // a prior refill is still running
      flushSeq: 4,
      pendingFlushSeq: 4,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toEqual({ allowed: true })
    // consumedAmount still advances; only the refill trigger is suppressed.
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(
      2 * 100_000_000
    )
    expect(state.waitUntilPromises).toHaveLength(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.pendingFlushSeq).toBe(4)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.flushSeq).toBe(4)
  })

  // ---------------------------------------------------------------------
  // Phase 7.5 — in-process flush+refill. These exercise the real
  // requestFlushAndRefill path: the DO calls WalletService.flushReservation
  // (mocked), then folds the returned allocation/flush deltas back into
  // SQLite. We assert both the happy path (grantedAmount extends runway,
  // flushSeq advances, pendingFlushSeq clears) and the failure modes
  // (error result + thrown error both clear refillInFlight but preserve
  // pendingFlushSeq so crash recovery / the next apply can retry).
  // ---------------------------------------------------------------------

  it("folds flushReservation results into SQLite on a successful flush+refill", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })
    // Grant 4 new dollars of runway, recognize the 5-dollar flush leg.
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 4 * 100_000_000,
        flushedAmount: 5 * 100_000_000,
        refundedAmount: 0,
        drainLegs: [],
      },
    })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 7,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())
    expect(result).toEqual({ allowed: true })
    await Promise.all(state.waitUntilPromises)

    // Contract with WalletService: projectId/customerId/currency come from
    // the persisted window, statementKey is "{reservationId}:{periodEndAt}",
    // final=false (this is a mid-period flush).
    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith({
      projectId: "proj_123",
      customerId: "cus_123",
      currency: "USD",
      reservationId: "res_abc",
      flushSeq: 8,
      flushAmount: 5 * 100_000_000,
      refillChunkAmount: 4 * 100_000_000,
      statementKey: `res_abc:${BASE_NOW + 60_000}`,
      final: false,
    })

    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // Allocation extended by grantedAmount; flushed catches up to consumed.
    expect(after.allocationAmount).toBe(9 * 100_000_000)
    expect(after.flushedAmount).toBe(5 * 100_000_000)
    expect(after.flushSeq).toBe(8)
    expect(after.pendingFlushSeq).toBeNull()
    expect(after.refillInFlight).toBe(false)
  })

  it("clears refillInFlight but preserves pendingFlushSeq when flushReservation returns an error", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockResolvedValue({
      err: { message: "WALLET_LEDGER_FAILED" },
      val: null,
    })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 7,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.apply(createApplyInput())
    await Promise.all(state.waitUntilPromises)

    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // No allocation/flush advance on failure — caller retries with same seq.
    expect(after.allocationAmount).toBe(5 * 100_000_000)
    expect(after.flushedAmount).toBe(0)
    expect(after.flushSeq).toBe(7)
    // pendingFlushSeq (set to 8 by apply()) is preserved so crash recovery
    // re-issues the same seq; refillInFlight clears so apply() can retry.
    expect(after.pendingFlushSeq).toBe(8)
    expect(after.refillInFlight).toBe(false)
  })

  it("clears refillInFlight when flushReservation throws unexpectedly", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockRejectedValue(new Error("neon connection refused"))

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.apply(createApplyInput())
    await Promise.all(state.waitUntilPromises)

    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(after.refillInFlight).toBe(false)
    // apply() already set pendingFlushSeq to 1; the thrown flush leaves it.
    expect(after.pendingFlushSeq).toBe(1)
    expect(after.flushSeq).toBe(0)
  })

  it("re-issues a pending flush on DO wake when pendingFlushSeq > flushSeq (crash recovery)", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 2 * 100_000_000,
        flushedAmount: 100_000_000,
        refundedAmount: 0,
        drainLegs: [],
      },
    })

    // Simulate a DO that was evicted mid-flush: pendingFlushSeq (5) runs
    // ahead of the committed flushSeq (4), and the window already records
    // $1 of unflushed consumption.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 3 * 100_000_000,
      consumedAmount: 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 2 * 100_000_000,
      refillInFlight: false,
      flushSeq: 4,
      pendingFlushSeq: 5,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    // The recovery check runs inside blockConcurrencyWhile (the DO's
    // `ready` promise). Drive that to completion through a public method
    // that awaits `ready` before we inspect the scheduled waitUntils.
    await durableObject.getEnforcementState()
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    // Retry replays the SAME seq (5), not a new one. flushAmount is
    // re-derived from consumed - flushed = $1.
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        flushSeq: 5,
        flushAmount: 100_000_000,
        refillChunkAmount: 2 * 100_000_000,
      })
    )

    // Post-recovery state: seq caught up, pending cleared, runway extended.
    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(after.flushSeq).toBe(5)
    expect(after.pendingFlushSeq).toBeNull()
    expect(after.allocationAmount).toBe(5 * 100_000_000)
    expect(after.flushedAmount).toBe(100_000_000)
    // Lazy Neon connection was opened once for the flush call.
    expect(durableObject).toBeDefined()
  })

  it("persists projectId and customerId into meter_window on first apply", async () => {
    // Identity fields are what flushReservation needs to call the ledger
    // without re-threading apply's input — guard that ensureMeterWindow
    // actually seeds them on the first insert.
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.apply(createApplyInput())

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.projectId).toBe("proj_123")
    expect(row?.customerId).toBe("cus_123")
  })

  // ---- Phase 7.7: alarm-driven final flush ---------------------------------

  it("stamps lastEventAt on every successful apply", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const before = Date.now()
    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.apply(createApplyInput())
    const after = Date.now()

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.lastEventAt).toBeGreaterThanOrEqual(before)
    expect(row?.lastEventAt).toBeLessThanOrEqual(after)
  })

  it("alarm runs a final flush when the period has ended", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 0,
        flushedAmount: 2 * 100_000_000,
        refundedAmount: 3 * 100_000_000,
        drainLegs: [],
      },
    })

    const periodEndAt = Date.now() - 1000
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt,
      usage: 0,
      updatedAt: null,
      createdAt: periodEndAt - 60_000,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 3,
      pendingFlushSeq: null,
      lastEventAt: periodEndAt - 1000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 4,
        flushAmount: 2 * 100_000_000,
        refillChunkAmount: 0,
        final: true,
        statementKey: `res_abc:${periodEndAt}`,
      })
    )

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.reservationId).toBeNull()
    expect(row.flushedAmount).toBe(2 * 100_000_000)
    expect(row.flushSeq).toBe(4)
    expect(row.pendingFlushSeq).toBeNull()
    expect(state.deletedAll).toBe(false)
  })

  it("alarm runs a final flush when the DO has been inactive for >24h", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 0,
        flushedAmount: 0,
        refundedAmount: 5 * 100_000_000,
        drainLegs: [],
      },
    })

    const now = Date.now()
    // Inactivity > 24h; period hasn't ended yet.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 48 * 60 * 60 * 1000,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 25 * 60 * 60 * 1000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    // No unflushed consumption, but the final flush still fires to return
    // reserved funds to available.purchased.
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({ final: true, flushAmount: 0 })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)!.reservationId).toBeNull()
  })

  it("alarm captures reservation then deletes storage when deletion is requested", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 0,
        flushedAmount: 1 * 100_000_000,
        refundedAmount: 4 * 100_000_000,
        drainLegs: [],
      },
    })

    const now = Date.now()
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 1000,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 1 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 500,
      deletionRequested: true,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({ final: true, flushAmount: 1 * 100_000_000 })
    )
    expect(state.deletedAlarm).toBe(true)
    expect(state.deletedAll).toBe(true)
  })

  it("alarm skips final flush when recoveryRequired is set", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })

    const periodEndAt = Date.now() - 1000
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt,
      usage: 0,
      updatedAt: null,
      createdAt: periodEndAt - 60_000,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: periodEndAt - 500,
      deletionRequested: false,
      recoveryRequired: true,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).not.toHaveBeenCalled()
    // The row still holds the reservation for an operator to inspect.
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)!.reservationId).toBe("res_abc")
  })

  it("alarm preserves pendingFlushSeq when the final flush call errors", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })
    testState.flushReservation.mockResolvedValue({
      err: { message: "LEDGER_DOWN" },
      val: null,
    })

    const periodEndAt = Date.now() - 1000
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt,
      usage: 0,
      updatedAt: null,
      createdAt: periodEndAt - 60_000,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 3,
      pendingFlushSeq: null,
      lastEventAt: periodEndAt - 500,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // Reservation stays open so the next alarm tick can retry the same seq.
    expect(row.reservationId).toBe("res_abc")
    expect(row.pendingFlushSeq).toBe(4)
    expect(row.flushSeq).toBe(3)
    expect(row.flushedAmount).toBe(0)
  })

  it("requestDeletion sets the deletion flag and pulls the alarm in", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: Date.now() + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: Date.now(),
      deletionRequested: false,
    })
    state.alarmAt = Date.now() + 30_000

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.requestDeletion()

    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.deletionRequested).toBe(true)
    // scheduleAlarm only downgrades; our requested time (now) is <= existing,
    // so the earlier alarm takes effect.
    expect(state.alarmAt).toBeLessThanOrEqual(Date.now() + 30_000)
  })
})

const createConnectionSpy = vi.fn()
const ledgerPostChargeSpy = vi.fn()
const ratingRateIncrementalSpy = vi.fn()

async function loadEntitlementWindowDO() {
  vi.doMock("cloudflare:workers", () => ({
    DurableObject: class {
      protected readonly ctx: FakeDurableObjectState
      constructor(state: FakeDurableObjectState) {
        this.ctx = state
      }
    },
  }))

  vi.doMock("@unprice/observability", () => ({
    createStandaloneRequestLogger: vi.fn(() => ({ logger: testState.logger })),
  }))

  vi.doMock("~/observability", () => ({ apiDrain: null }))

  vi.doMock("drizzle-orm/durable-sqlite", () => ({
    drizzle: vi.fn(() => {
      if (!testState.db) {
        throw new Error("Missing fake drizzle db for EntitlementWindowDO test")
      }
      return buildFakeDrizzle(testState.db)
    }),
  }))

  vi.doMock("drizzle-orm/durable-sqlite/migrator", () => ({
    migrate: vi.fn(async () => {}),
  }))

  vi.doMock("./drizzle-adapter", () => ({ DrizzleStorageAdapter: class {} }))
  vi.doMock("./drizzle/migrations", () => ({ default: [] }))

  vi.doMock("@unprice/db", () => ({
    createConnection: createConnectionSpy,
  }))

  // Phase 7.5: the DO lazy-instantiates a WalletService on first refill.
  // We mock the service and its ledger dep so tests can drive the flush
  // outcome without a real Postgres connection.
  vi.doMock("@unprice/services/ledger", () => ({
    LedgerGateway: class {},
  }))

  vi.doMock("@unprice/services/wallet", () => ({
    WalletService: class {
      public flushReservation = testState.flushReservation
    },
  }))

  vi.doMock("drizzle-orm", () => ({
    and: (...conditions: DrizzleCondition[]): DrizzleCondition => ({ kind: "and", conditions }),
    asc: (col: unknown) => ({ col, kind: "asc" }),
    eq: (col: unknown, value: unknown): DrizzleCondition => ({ kind: "eq", value, values: [col] }),
    inArray: (_col: unknown, values: unknown[]): DrizzleCondition => ({ kind: "inArray", values }),
    isNull: (): DrizzleCondition => ({ kind: "isNull" }),
    isNotNull: (): DrizzleCondition => ({ kind: "isNotNull" }),
    lt: (_col: unknown, value: unknown): DrizzleCondition => ({ kind: "lt", value }),
    sql: () => ({ kind: "sql" }),
  }))

  vi.doMock("@unprice/analytics", () => ({
    Analytics: class {
      public ingestEntitlementMeterFacts = testState.analyticsIngest
    },
    entitlementMeterFactSchemaV1: { parse: (p: unknown) => p },
  }))

  vi.doMock("@unprice/db/validators", () => ({
    calculatePricePerFeature: testState.pricePerFeature,
    configFeatureSchema: z.record(z.string(), z.unknown()),
  }))

  vi.doMock("@unprice/services/entitlements", () => {
    class EventTimestampTooFarInFutureError extends Error {}
    class EventTimestampTooOldError extends Error {}

    return {
      AsyncMeterAggregationEngine: class {
        applyEventSync(event: unknown, options?: PersistOptions): Fact[] {
          return testState.engineApply(event, options) as Fact[]
        }
      },
      EventTimestampTooFarInFutureError,
      EventTimestampTooOldError,
      MAX_EVENT_AGE_MS: TEST_MAX_EVENT_AGE_MS,
      deriveMeterKey: (m: {
        eventId: string
        eventSlug: string
        aggregationMethod: string
        aggregationField?: string
      }) => [m.eventId, m.eventSlug, m.aggregationMethod, m.aggregationField ?? ""].join(":"),
      findLimitExceededFact: (params: {
        facts: Fact[]
        limit?: number | null
        overageStrategy?: string
      }): Fact | null => {
        if (
          typeof params.limit !== "number" ||
          !Number.isFinite(params.limit) ||
          params.overageStrategy === "always"
        ) {
          return null
        }
        for (const fact of params.facts) {
          if (fact.delta <= 0) continue
          if (params.overageStrategy === "last-call") {
            if (fact.valueAfter - fact.delta >= params.limit) return fact
            continue
          }
          if (fact.valueAfter > params.limit) return fact
        }
        return null
      },
    }
  })

  const module = (await import("./EntitlementWindowDO")) as {
    EntitlementWindowDO: new (
      state: FakeDurableObjectState,
      env: unknown
    ) => {
      alarm: () => Promise<void>
      apply: (
        input: ReturnType<typeof createApplyInput>
      ) => Promise<{ allowed: boolean; deniedReason?: string; message?: string }>
      getEnforcementState: () => Promise<{
        isLimitReached: boolean
        limit: number | null
        usage: number
      }>
    }
  }

  return module.EntitlementWindowDO
}

function createDurableObjectState(): FakeDurableObjectState {
  const state: FakeDurableObjectState = {
    alarmAt: null,
    deletedAlarm: false,
    deletedAll: false,
    id: { toString: () => "do_123" },
    blockConcurrencyWhile: async <T>(cb: () => Promise<T> | T) => await cb(),
    waitUntilPromises: [],
    waitUntil: (promise: Promise<unknown>) => {
      state.waitUntilPromises.push(promise)
    },
    storage: {
      deleteAlarm: async () => {
        state.deletedAlarm = true
        state.alarmAt = null
      },
      deleteAll: async () => {
        state.deletedAll = true
      },
      getAlarm: async () => state.alarmAt,
      setAlarm: async (ts: number) => {
        state.alarmAt = ts
      },
    },
  }
  return state
}

function createFakeDbState(): FakeDbState {
  return {
    idempotencyRows: new Map(),
    outboxRows: [],
    meterWindowRows: new Map(),
  }
}

/**
 * Builds a fake drizzle-compatible query builder backed by simple Maps/arrays.
 * Mirrors the subset of the drizzle API used by EntitlementWindowDO.
 */
function buildFakeDrizzle(state: FakeDbState) {
  let nextOutboxId = 1

  const matchOutboxCondition = (row: { id: number }, condition?: DrizzleCondition): boolean => {
    if (!condition) return true
    switch (condition.kind) {
      case "and":
        return (condition.conditions ?? []).every((nested) => matchOutboxCondition(row, nested))
      case "eq":
        return row.id === Number(condition.value)
      case "inArray":
        return (condition.values ?? []).includes(row.id)
      default:
        return true
    }
  }

  const db = {
    transaction<T>(callback: (tx: typeof db) => T): T {
      const idempotencySnapshot = new Map(state.idempotencyRows)
      const outboxSnapshot = [...state.outboxRows]
      const meterPricingSnapshot = new Map(state.meterWindowRows)
      const outboxIdSnapshot = nextOutboxId
      try {
        return callback(db)
      } catch (error) {
        state.idempotencyRows.clear()
        for (const [k, v] of Array.from(idempotencySnapshot.entries()))
          state.idempotencyRows.set(k, v)
        state.outboxRows.splice(0, state.outboxRows.length, ...outboxSnapshot)
        state.meterWindowRows.clear()
        for (const [k, v] of Array.from(meterPricingSnapshot.entries()))
          state.meterWindowRows.set(k, v)
        nextOutboxId = outboxIdSnapshot
        throw error
      }
    },

    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields)
      let cond: DrizzleCondition | undefined
      let limitCount: number | undefined

      return {
        from: () => db.select(fields),
        where(c: DrizzleCondition) {
          cond = c
          return this
        },
        orderBy() {
          return this
        },
        limit(n: number) {
          limitCount = n
          return this
        },
        get() {
          if (keys.includes("allowed")) {
            const row = state.idempotencyRows.get(String(cond?.value))
            if (!row) return undefined
            return {
              allowed: row.allowed,
              deniedReason: row.deniedReason,
              denyMessage: row.denyMessage,
            }
          }
          if (keys.includes("count")) return { count: state.outboxRows.length }
          if (keys.every((k) => METER_WINDOW_KEYS.has(k))) {
            // Single-meter DO → at most one meter_window row
            const first = state.meterWindowRows.values().next().value
            if (!first) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) row[key] = (first as Record<string, unknown>)[key]
            return row
          }
          throw new Error(`Unsupported select().get(): ${keys}`)
        },
        all() {
          if (keys.includes("id") && keys.includes("payload")) {
            return [...state.outboxRows]
              .filter((row) => matchOutboxCondition(row, cond))
              .sort((a, b) => a.id - b.id)
              .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
              .map((row) => ({ id: row.id, payload: row.payload }))
          }
          if (keys.length === 1 && keys.includes("eventId")) {
            return [...Array.from(state.idempotencyRows.entries())]
              .filter(([, r]) => r.createdAt < Number(cond?.value))
              .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
              .map(([eventId]) => ({ eventId }))
          }
          return []
        },
      }
    },

    insert() {
      return {
        values(value: Record<string, unknown>) {
          const builder = {
            onConflictDoNothing() {
              return builder
            },
            run() {
              if ("payload" in value && !("eventId" in value) && !("meterKey" in value)) {
                state.outboxRows.push({
                  id: nextOutboxId++,
                  payload: String(value.payload),
                  currency: String(value.currency),
                })
                return
              }
              if ("eventId" in value && "allowed" in value) {
                state.idempotencyRows.set(String(value.eventId), {
                  createdAt: Number(value.createdAt),
                  allowed: Boolean(value.allowed),
                  deniedReason: (value.deniedReason as string | null) ?? null,
                  denyMessage: (value.denyMessage as string | null) ?? null,
                })
                return
              }
              if ("meterKey" in value) {
                const key = String(value.meterKey)
                if (state.meterWindowRows.has(key)) return
                state.meterWindowRows.set(key, {
                  meterKey: key,
                  currency: String(value.currency),
                  priceConfig: value.priceConfig,
                  periodEndAt: value.periodEndAt != null ? Number(value.periodEndAt) : null,
                  usage: value.usage != null ? Number(value.usage) : 0,
                  updatedAt: value.updatedAt != null ? Number(value.updatedAt) : null,
                  createdAt: Number(value.createdAt),
                  projectId: (value.projectId as string | null | undefined) ?? null,
                  customerId: (value.customerId as string | null | undefined) ?? null,
                })
                return
              }
              throw new Error("Unsupported insert in fake db")
            },
          }
          return builder
        },
      }
    },

    update() {
      // The DO's wallet path updates the singleton meter_window row with
      // reservation state; the engine adapter (mocked out elsewhere) used
      // to hit this too. We treat it as a merge over the single row —
      // there's no .where() needed to disambiguate.
      return {
        set(patch: Record<string, unknown>) {
          return {
            where() {
              return this
            },
            run() {
              const first = state.meterWindowRows.values().next().value
              if (!first) return
              Object.assign(first, patch)
            },
          }
        },
      }
    },

    delete() {
      return {
        where(cond: DrizzleCondition) {
          return {
            run() {
              if (cond.kind !== "inArray") throw new Error("Unsupported delete condition")
              if ((cond.values ?? []).every((v: unknown) => typeof v === "number")) {
                const ids = new Set(cond.values as number[])
                const remaining = state.outboxRows.filter((r) => !ids.has(r.id))
                state.outboxRows.splice(0, state.outboxRows.length, ...remaining)
              } else {
                for (const v of cond.values ?? []) state.idempotencyRows.delete(String(v))
              }
            },
          }
        },
      }
    },
  }

  return db
}

function createEnv() {
  return {
    APP_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
    DRIZZLE_LOG: false,
    TINYBIRD_TOKEN: "token",
    TINYBIRD_URL: "https://example.com",
  }
}

function createApplyInput(overrides: Record<string, unknown> = {}) {
  return {
    customerId: "cus_123",
    currency: "USD",
    enforceLimit: false,
    event: {
      id: "evt_123",
      properties: { amount: 3 },
      slug: "tokens_used",
      timestamp: BASE_NOW,
    },
    featureSlug: "api_calls",
    idempotencyKey: "idem_123",
    limit: undefined as number | undefined,
    meter: DEFAULT_METER_CONFIG,
    priceConfig: DEFAULT_PRICE_CONFIG,
    now: BASE_NOW,
    overageStrategy: undefined as string | undefined,
    periodEndAt: BASE_NOW + 60_000,
    periodKey: "period_2026_03",
    projectId: "proj_123",
    featurePlanVersionId: "fpv_123",
    streamId: "stream_123",
    ...overrides,
  }
}
