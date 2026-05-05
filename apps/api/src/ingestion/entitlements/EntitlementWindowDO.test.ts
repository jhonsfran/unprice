import { diffLedgerMinor } from "@unprice/money"
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
const TEST_INGESTION_MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TEST_DO_IDEMPOTENCY_TTL_MS = TEST_INGESTION_MAX_EVENT_AGE_MS + 7 * 24 * 60 * 60 * 1000
const TEST_LATE_EVENT_GRACE_MS = 60 * 60 * 1000

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
  reservationEndAt?: number | null
  usage: number
  updatedAt: number | null
  createdAt: number
  // Identity + reservation columns; null/zero until activation sets them.
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
  // Alarm trigger columns.
  lastEventAt?: number | null
  lastFlushedAt?: number | null
  deletionRequested?: boolean
  recoveryRequired?: boolean
}

type GrantWindowRow = {
  bucketKey: string
  consumedInCurrentWindow: number
  exhaustedAt: number | null
  grantId: string
  periodEndAt: number
  periodKey: string
  periodStartAt: number
}

type GrantRow = {
  grantId: string
  allowanceUnits: number | null
  effectiveAt: number
  expiresAt: number | null
  priority: number
  addedAt: number
}

type EntitlementConfigRow = {
  customerEntitlementId: string
  projectId: string
  customerId: string
  effectiveAt: number
  expiresAt: number | null
  featureConfig: unknown
  featurePlanVersionId: string
  featureSlug: string
  meterConfig: unknown
  overageStrategy: string
  resetConfig: unknown
  addedAt: number
  updatedAt: number
}

const METER_WINDOW_KEYS = new Set<string>([
  "meterKey",
  "currency",
  "priceConfig",
  "periodEndAt",
  "reservationEndAt",
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
  "lastFlushedAt",
  "deletionRequested",
  "recoveryRequired",
])

const GRANT_WINDOW_KEYS = new Set<string>([
  "bucketKey",
  "grantId",
  "periodKey",
  "periodStartAt",
  "periodEndAt",
  "consumedInCurrentWindow",
  "exhaustedAt",
])

const GRANT_KEYS = new Set<string>([
  "grantId",
  "allowanceUnits",
  "effectiveAt",
  "expiresAt",
  "priority",
  "addedAt",
])

const ENTITLEMENT_CONFIG_KEYS = new Set<string>([
  "customerEntitlementId",
  "projectId",
  "customerId",
  "effectiveAt",
  "expiresAt",
  "featureConfig",
  "featurePlanVersionId",
  "featureSlug",
  "meterConfig",
  "overageStrategy",
  "resetConfig",
  "addedAt",
  "updatedAt",
])

type FakeDbState = {
  entitlementConfigRows: Map<string, EntitlementConfigRow>
  idempotencyRows: Map<string, IdempotencyRow>
  outboxRows: { id: number; payload: string; currency: string }[]
  meterWindowRows: Map<string, MeterWindowRow>
  grantRows: Map<string, GrantRow>
  grantWindowRows: Map<string, GrantWindowRow>
  deleteInArrayBatchSizes: number[]
  maxDeleteInArrayValues?: number
}

type FakeDurableObjectState = {
  alarmAt: number | null
  deletedAlarm: boolean
  deletedAll: boolean
  id: { toString: () => string }
  blockConcurrencyWhile: <T>(cb: () => Promise<T> | T) => Promise<T>
  // apply() schedules flush+refill via ctx.waitUntil. We record the scheduled
  // promise so tests can assert the refill was triggered and await its
  // completion before making assertions on db state.
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
  // Lazy reservation bootstrap. Default returns a healthy reservation so
  // existing tests that don't care about the wallet path stay green; tests
  // that exercise WALLET_EMPTY override per-test.
  createReservation: vi.fn(),
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
    testState.createReservation.mockReset()
    // Default: flush+refill settles with zero runway so tests that don't
    // opt into the wallet path stay identical to their pre-7.5 shape.
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: { grantedAmount: 0, flushedAmount: 0, refundedAmount: 0, drainLegs: [] },
    })
    // Default: lazy bootstrap returns a healthy reservation. Tests that need
    // the WALLET_EMPTY surface (allocationAmount: 0) or wallet-error paths
    // override this per-test.
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_lazy_default",
        allocationAmount: 1_000_000_000, // $10, the sizing ceiling
        drainLegs: [],
      },
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

  it("rejects events for a closed period after the late-event grace window", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodEndAt = BASE_NOW - TEST_LATE_EVENT_GRACE_MS - 1
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        periodStartAt: periodEndAt - 60_000,
        periodEndAt,
        event: {
          timestamp: periodEndAt - 1,
        },
      })
    )

    expect(result.allowed).toBe(false)
    expect(result.deniedReason).toBe("LATE_EVENT_CLOSED_PERIOD")
    expect(testState.engineApply).not.toHaveBeenCalled()
    expect(testState.createReservation).not.toHaveBeenCalled()
    expect(db.outboxRows).toHaveLength(0)
    expect(db.idempotencyRows.get("idem_123")).toMatchObject({
      allowed: false,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("accepts late events that are still inside the grace window", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodEndAt = BASE_NOW - TEST_LATE_EVENT_GRACE_MS + 1
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        periodStartAt: periodEndAt - 60_000,
        periodEndAt,
        event: {
          timestamp: periodEndAt - 1,
        },
      })
    )

    expect(result).toEqual({ allowed: true })
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(db.outboxRows).toHaveLength(1)
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
    db.grantWindowRows.set(`grant_123:onetime:${BASE_NOW - 60_000}`, {
      bucketKey: `grant_123:onetime:${BASE_NOW - 60_000}`,
      grantId: "grant_123",
      periodKey: `onetime:${BASE_NOW - 60_000}`,
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 6,
      exhaustedAt: null,
    })
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
      ["missing meter", { entitlement: { meterConfig: null } }],
      ["non-finite limit", { grants: [createGrantSnapshot({ amount: Number.POSITIVE_INFINITY })] }],
      [
        "unsupported overage strategy",
        { entitlement: { overageStrategy: "sometimes" }, overageStrategy: "sometimes" },
      ],
      ["nan period end", { grants: [createGrantSnapshot({ expiresAt: Number.NaN })] }],
      ["missing price config", { entitlement: { featureConfig: null } }],
      ["missing plan version id", { entitlement: { featurePlanVersionId: "" } }],
    ]

    for (const [, overrides] of cases) {
      const EntitlementWindowDO = await loadEntitlementWindowDO()
      const state = createDurableObjectState()
      const db = createFakeDbState()
      testState.db = db

      const durableObject = new EntitlementWindowDO(state, createEnv())
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid input
      const input = createApplyInput(overrides) as any

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
        feature_slug: input.entitlement.featureSlug,
        feature_plan_version_id: "fpv_123",
        idempotency_key: input.idempotencyKey,
        value_after: 2,
        amount: 200_000_000,
        amount_scale: 8,
        currency: "USD",
      }),
    ])
    expect(db.outboxRows).toHaveLength(0)
    // The default mocked apply opens a wallet reservation, so alarm() re-arms
    // at the time-based flush deadline (5 min in non-dev) rather than the
    // distant self-destruct. The flush deadline wins because it's sooner.
    expect(state.alarmAt).toBe(BASE_NOW + 5 * 60_000)
  })

  it("cleans alarm outbox and idempotency rows in SQLite bind-safe chunks", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    db.maxDeleteInArrayValues = 90
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({
      quarantined_rows: 0,
      successful_rows: 200,
    })

    for (let index = 1; index <= 200; index++) {
      db.outboxRows.push({
        id: index,
        currency: "USD",
        payload: JSON.stringify({
          id: `fact_${index}`,
          event_id: `evt_${index}`,
          idempotency_key: `idem_${index}`,
          project_id: "proj_123",
          customer_id: "cus_123",
          currency: "USD",
          customer_entitlement_id: "ce_123",
          feature_slug: "api_calls",
          period_key: "period_123",
          event_slug: "tokens_used",
          aggregation_method: "sum",
          timestamp: BASE_NOW,
          created_at: BASE_NOW,
          delta: 1,
          value_after: index,
          amount: 100_000_000,
          amount_scale: 8,
          priced_at: BASE_NOW,
        }),
      })
      db.idempotencyRows.set(`stale_evt_${index}`, {
        createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
        allowed: true,
        deniedReason: null,
        denyMessage: null,
      })
    }

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    expect(testState.analyticsIngest).toHaveBeenCalledTimes(1)
    expect(db.outboxRows).toHaveLength(0)
    expect(db.idempotencyRows.size).toBe(0)
    expect(db.deleteInArrayBatchSizes.length).toBeGreaterThan(2)
    expect(db.deleteInArrayBatchSizes.every((size) => size <= 90)).toBe(true)
  })

  it("reschedules a fired alarm when a flush batch leaves facts in the outbox", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockImplementation((facts: unknown[]) =>
      Promise.resolve({
        quarantined_rows: 0,
        successful_rows: facts.length,
      })
    )

    // Simulate runtimes/tests that still expose the just-fired alarm timestamp
    // while alarm() is running. It must be replaced if the outbox still has work.
    state.alarmAt = BASE_NOW

    for (let index = 1; index <= 1200; index++) {
      db.outboxRows.push({
        id: index,
        currency: "USD",
        payload: JSON.stringify({
          id: `fact_${index}`,
          event_id: `evt_${index}`,
          idempotency_key: `idem_${index}`,
          project_id: "proj_123",
          customer_id: "cus_123",
          currency: "USD",
          customer_entitlement_id: "ce_123",
          feature_slug: "api_calls",
          period_key: "period_123",
          event_slug: "tokens_used",
          aggregation_method: "sum",
          timestamp: BASE_NOW,
          created_at: BASE_NOW,
          delta: 1,
          value_after: index,
          amount: 100_000_000,
          amount_scale: 8,
          priced_at: BASE_NOW,
        }),
      })
    }

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    expect(testState.analyticsIngest).toHaveBeenCalledTimes(1)
    expect(db.outboxRows).toHaveLength(700)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
  })

  it("retains idempotency rows past the ingestion age cap and cleans them at the DO TTL", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    db.idempotencyRows.set("inside_retention_margin", {
      createdAt: BASE_NOW - TEST_INGESTION_MAX_EVENT_AGE_MS - 24 * 60 * 60 * 1000,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
    })
    db.idempotencyRows.set("beyond_do_ttl", {
      createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    expect(db.idempotencyRows.has("inside_retention_margin")).toBe(true)
    expect(db.idempotencyRows.has("beyond_do_ttl")).toBe(false)
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

  it("does not call ledger/rating services for free features (no lazy reservation needed)", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    // Free feature: marginal price is 0, so the lazy bootstrap is skipped
    // and the DO never touches Postgres or the wallet path.
    testState.pricePerFeature.mockImplementation(() => ({
      val: { totalPrice: { dinero: fakeDinero(0, 2) } },
    }))
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
    expect(testState.createReservation).not.toHaveBeenCalled()
    expect(ledgerPostChargeSpy).not.toHaveBeenCalled()
    expect(ratingRateIncrementalSpy).not.toHaveBeenCalled()
  })

  it("rates same-stream applies from the entitlement config snapshot", async () => {
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

    // First apply hydrates the raw meter-state row. Pricing comes from the
    // entitlement snapshot, not the meter row or allowance grants.
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_a",
        featurePlanVersionId: "fpv_a",
        grants: [createGrantSnapshot({ grantId: "grant_a" })],
      })
    )
    expect(db.meterWindowRows.size).toBe(1)
    const pricingRow = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(pricingRow?.currency).toBe("USD")
    expect(pricingRow?.priceConfig).toBeUndefined()

    // Second apply brings a higher-priority addon grant on the same stream.
    // The meter row stays singleton, but rating/audit still follows the
    // entitlement snapshot.
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_b",
        featurePlanVersionId: "fpv_a",
        grants: [
          createGrantSnapshot({
            grantId: "grant_b",
            priority: 20,
          }),
          createGrantSnapshot({ grantId: "grant_a" }),
        ],
      })
    )

    expect(db.meterWindowRows.size).toBe(1)
    expect(db.outboxRows).toHaveLength(2)
    const fpvs = db.outboxRows.map((row) => JSON.parse(row.payload).feature_plan_version_id)
    expect(fpvs).toEqual(["fpv_a", "fpv_a"])

    await expect(
      durableObject.apply(
        createApplyInput({
          idempotencyKey: "idem_mutated_config",
          featurePlanVersionId: "fpv_b",
          grants: [createGrantSnapshot({ grantId: "grant_c" })],
        })
      )
    ).rejects.toThrow("Immutable entitlement config changed")
  })

  it("splits one usage fact across canonical grants using the entitlement price", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    testState.pricePerFeature.mockImplementation(
      ({ quantity, config }: { quantity: number; config: { unitAmount?: number } }) => ({
        val: {
          totalPrice: {
            dinero: fakeDinero(Math.max(0, quantity) * (config.unitAmount ?? 100), 2),
          },
        },
      })
    )
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        featurePlanVersionId: "fpv_entitlement",
        priceConfig: { ...DEFAULT_PRICE_CONFIG, unitAmount: 100 },
        grants: [
          createGrantSnapshot({
            grantId: "grant_a",
            amount: 3,
            featureConfig: { ...DEFAULT_PRICE_CONFIG, unitAmount: 100 },
            priority: 20,
          }),
          createGrantSnapshot({
            grantId: "grant_b",
            amount: 10,
            featureConfig: { ...DEFAULT_PRICE_CONFIG, unitAmount: 200 },
            priority: 10,
          }),
        ],
      })
    )

    expect(result).toEqual({ allowed: true })
    expect(db.outboxRows).toHaveLength(2)

    const payloads = db.outboxRows.map((row) => JSON.parse(row.payload))
    expect(payloads.map((payload) => payload.grant_id)).toEqual(["grant_a", "grant_b"])
    expect(payloads.map((payload) => payload.feature_plan_version_id)).toEqual([
      "fpv_entitlement",
      "fpv_entitlement",
    ])
    expect(payloads.map((payload) => payload.delta)).toEqual([3, 2])
    expect(payloads.map((payload) => payload.amount)).toEqual([300_000_000, 200_000_000])

    expect(db.grantWindowRows.get(`grant_a:onetime:${BASE_NOW - 60_000}`)).toMatchObject({
      consumedInCurrentWindow: 3,
      exhaustedAt: BASE_NOW,
    })
    expect(db.grantWindowRows.get(`grant_b:onetime:${BASE_NOW - 60_000}`)).toMatchObject({
      consumedInCurrentWindow: 2,
      exhaustedAt: null,
    })
  })

  it("uses persisted grant data as source of truth and only applies expiry updates", async () => {
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
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_original",
        featurePlanVersionId: "fpv_original",
        grants: [
          createGrantSnapshot({
            grantId: "grant_stable",
            amount: 50,
            expiresAt: BASE_NOW + 60_000,
          }),
        ],
      })
    )

    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_mutated",
        featurePlanVersionId: "fpv_original",
        grants: [
          createGrantSnapshot({
            grantId: "grant_stable",
            amount: 999,
            expiresAt: BASE_NOW + 10_000,
            priority: 999,
          }),
        ],
      })
    )

    expect(db.grantRows.get("grant_stable")).toMatchObject({
      allowanceUnits: 50,
      expiresAt: BASE_NOW + 10_000,
      priority: 10,
    })

    const payloads = db.outboxRows.map((row) => JSON.parse(row.payload))
    expect(payloads.map((payload) => payload.feature_plan_version_id)).toEqual([
      "fpv_original",
      "fpv_original",
    ])
    expect(payloads.map((payload) => payload.feature_slug)).toEqual(["api_calls", "api_calls"])
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

  it("getEnforcementState summarizes active grant-window usage", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_enforcement_state",
        allocationAmount: 100 * 100_000_000,
        drainLegs: [],
      },
    })

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

    // Apply #2: usage 7 exactly at the new grant's limit 7 → reached
    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 7, meterKey: DEFAULT_METER_KEY, valueAfter: 14 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_2",
        grants: [
          createGrantSnapshot({ grantId: "grant_123", expiresAt: BASE_NOW - 1 }),
          createGrantSnapshot({ grantId: "grant_limit_7", amount: 7 }),
        ],
      })
    )
    expect(await durableObject.getEnforcementState()).toEqual({
      usage: 7,
      limit: 7,
      isLimitReached: true,
    })

    // Apply #3: overageStrategy "always" suppresses isLimitReached for the active grant
    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 10 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_3",
        grants: [
          createGrantSnapshot({ grantId: "grant_limit_7", amount: 7, expiresAt: BASE_NOW - 1 }),
          createGrantSnapshot({
            grantId: "grant_always",
            amount: 7,
            overageStrategy: "always",
          }),
        ],
      })
    )
    expect(await durableObject.getEnforcementState()).toEqual({
      usage: 3,
      limit: 7,
      isLimitReached: false,
    })
  })

  it("does not write grant-window usage when an oversized event is rejected", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      // Engine would bump usage 0 → 11, but beforePersist rejects it → tx rolls back.
      const facts = [{ delta: 11, meterKey: DEFAULT_METER_KEY, valueAfter: 11 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const denied = await durableObject.apply(createApplyInput({ enforceLimit: true, limit: 10 }))
    expect(denied.allowed).toBe(false)

    const result = await durableObject.getEnforcementState()
    expect(result).toEqual({ usage: 0, limit: 10, isLimitReached: false })
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

    // First DO instance performs the apply; reservationEndAt lands in the
    // wallet reservation row so it survives eviction.
    const first = new EntitlementWindowDO(state, createEnv())
    await first.apply(input)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationEndAt).toBe(
      input.grants[0]!.expiresAt
    )

    // Simulate eviction: Cloudflare clears the alarm and evicts the DO.
    state.alarmAt = null
    const revived = new EntitlementWindowDO(state, createEnv())

    await revived.alarm()

    // The revived DO sees a still-open reservation in SQLite and re-arms
    // alarm() at the time-based flush deadline (5 min in non-dev) — the
    // soonest deadline among self-destruct and the freshness floor.
    expect(state.alarmAt).toBe(BASE_NOW + 5 * 60_000)
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
  // Wallet hot path. These exercise the reservation-aware branch of apply():
  // the window row must be seeded with a reservation for the branch to engage;
  // otherwise the DO keeps its non-reserved behavior (covered by the earlier
  // tests in this suite).
  // ---------------------------------------------------------------------

  it("opens a reservation lazily on first priced apply", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_lazy",
        allocationAmount: 5 * 100_000_000,
        drainLegs: [],
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toEqual({ allowed: true })
    // Bootstrap fired with the period window from the input.
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(testState.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_123",
        customerId: "cus_123",
        currency: "USD",
        entitlementId: "ce_123",
      })
    )
    // The reservation is persisted onto the window so subsequent events use
    // the in-tx LocalReservation check directly.
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.reservationId).toBe("res_lazy")
    expect(row?.allocationAmount).toBe(5 * 100_000_000)
  })

  it("denies with WALLET_EMPTY when the lazy bootstrap allocation is 0", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    // Wallet has nothing to back the reservation — allocation comes back 0.
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_empty",
        allocationAmount: 0,
        drainLegs: [],
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    // Denial is durable: subsequent retries hit the idempotency cache and
    // skip the wallet entirely.
    expect(db.idempotencyRows.get("idem_123")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
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
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(2 * 100_000_000 - 10)
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
    // Refill was scheduled via ctx.waitUntil; the stub body settles
    // synchronously on the microtask queue, so by the time this assertion runs
    // the single-flight flag has already cleared.
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
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(2 * 100_000_000)
    expect(state.waitUntilPromises).toHaveLength(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.pendingFlushSeq).toBe(4)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.flushSeq).toBe(4)
  })

  // ---------------------------------------------------------------------
  // In-process flush+refill. These exercise the real requestFlushAndRefill
  // path: the DO calls WalletService.flushReservation
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
      sourceId: "do_123",
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

  it("does not auto-recover pending flushes marked recoveryRequired", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

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
      recoveryRequired: true,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.getEnforcementState()
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.pendingFlushSeq).toBe(5)
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

  // ---- Alarm-driven final flush --------------------------------------------

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

  it("alarm runs a final flush when the DO has been inactive for >12h", async () => {
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
    // Inactivity > 12h; period hasn't ended yet.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 24 * 60 * 60 * 1000,
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
      lastEventAt: now - 13 * 60 * 60 * 1000,
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

  it("alarm keeps a live reservation open before the 12h inactivity threshold", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })

    const now = Date.now()
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 24 * 60 * 60 * 1000,
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
      lastEventAt: now - 11 * 60 * 60 * 1000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)!.reservationId).toBe("res_abc")
    expect(state.deletedAlarm).toBe(false)
    expect(state.deletedAll).toBe(false)
  })

  it("alarm captures reservation then deletes storage when deletion cleanup completes", async () => {
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
    expect(testState.logger.warn).not.toHaveBeenCalled()
  })

  it("alarm keeps storage and alerts when Tinybird blocks deletion cleanup", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockRejectedValueOnce(new Error("tinybird down"))
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
    db.outboxRows.push({
      id: 1,
      currency: "USD",
      payload: JSON.stringify({
        id: "fact_123",
        event_id: "evt_123",
        idempotency_key: "idem_123",
        project_id: "proj_123",
        customer_id: "cus_123",
        currency: "USD",
        customer_entitlement_id: "ce_123",
        feature_slug: "api_calls",
        period_key: "period_123",
        event_slug: "tokens_used",
        aggregation_method: "sum",
        timestamp: now,
        created_at: now,
        delta: 1,
        value_after: 1,
        amount: 100_000_000,
        amount_scale: 8,
        priced_at: now,
      }),
    })
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
    expect(db.outboxRows).toHaveLength(1)
    expect(state.deletedAlarm).toBe(true)
    expect(state.deletedAll).toBe(false)
    expect(testState.logger.warn).toHaveBeenCalledWith(
      "entitlement deletion cleanup failed",
      expect.objectContaining({
        operator_action_required: true,
        outbox_remaining: 1,
        tinybird_flush_failed: true,
      })
    )
  })

  it("alarm leaves pending wallet flushes for an operator during deletion", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })

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
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 1 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: true,
      flushSeq: 1,
      pendingFlushSeq: 2,
      lastEventAt: now - 500,
      deletionRequested: true,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(state.deletedAlarm).toBe(true)
    expect(state.deletedAll).toBe(false)
    expect(testState.logger.warn).toHaveBeenCalledWith(
      "entitlement deletion has pending wallet flush",
      expect.objectContaining({
        operator_action_required: true,
        pending_flush_seq: 2,
        refill_in_flight: true,
        reservation_id: "res_abc",
      })
    )
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

  it("alarm marks recoveryRequired when the final flush call errors", async () => {
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
    // Reservation stays open for an operator to inspect/replay the same seq.
    expect(row.reservationId).toBe("res_abc")
    expect(row.pendingFlushSeq).toBe(4)
    expect(row.flushSeq).toBe(3)
    expect(row.flushedAmount).toBe(0)
    expect(row.refillInFlight).toBe(false)
    expect(row.recoveryRequired).toBe(true)
  })

  // ---------------------------------------------------------------------
  // Volume-tier with per-tier flat fee.
  //   tier 1: 1..30  @ €0/unit  + €0    flat
  //   tier 2: 31..∞ @ €0.001/unit + €1   flat
  // In volume mode, when usage crosses into tier 2 the *entire* reading is
  // priced at tier-2 rates: 31 units → 31×€0.001 + €1 = €1.031. The DO
  // captures this as a single boundary-crossing delta:
  //   price(31) − price(30) = €1.031 − €0 = €1.031
  // Subsequent events inside tier 2 only see the per-unit increment
  // because the flat fee already accrued at the crossing event. Together
  // these tests pin the contract that the realtime pricing path includes
  // the per-tier flat fee, not just the per-unit rate.
  // ---------------------------------------------------------------------

  // Mirrors the volume-tier behaviour of the real `calculatePricePerFeature`
  // for the user's exact config, so the DO sees realistic before/after
  // dineros and `diffLedgerMinor` produces real ledger-scale amounts.
  // €0.001/unit is stored at scale-3, €1 flat at scale-2; dinero rescales
  // both to scale-3 on add → q + 1000 minor units at scale-3.
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

  function priceVolumeFlatTier(quantity: number): Dinero<number> {
    const q = Math.max(0, quantity)
    if (q === 0 || q <= 30) return fakeDinero(0, 2)
    // tier 2: q × 0.001 + 1.00. At common scale-3 → q + 1000 minor units.
    return fakeDinero(q + 1000, 3)
  }

  function mockVolumeFlatTierPricing() {
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: { totalPrice: { dinero: priceVolumeFlatTier(quantity) } },
    }))
  }

  it("prices the tier-2 boundary-crossing event including the tier flat fee", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    mockVolumeFlatTierPricing()

    // Engine reports the cumulative jump 30 → 31 (delta=1, valueAfter=31).
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 31 }]
      options?.beforePersist?.(facts)
      return facts
    })

    // Pre-seed a reservation with plenty of allocation so the wallet check
    // passes and we can assert on the priced amount written to the outbox.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 30,
      updatedAt: BASE_NOW - 1_000,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 10 * 100_000_000, // €10 — enough for a €1.031 hit
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 250_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })
    db.grantWindowRows.set(`grant_123:onetime:${BASE_NOW - 60_000}`, {
      bucketKey: `grant_123:onetime:${BASE_NOW - 60_000}`,
      grantId: "grant_123",
      periodKey: `onetime:${BASE_NOW - 60_000}`,
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 30,
      exhaustedAt: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
      })
    )

    expect(result).toEqual({ allowed: true })

    // €1.031 = 1 × 10^8 + 31 × 10^5 = 103_100_000 minor units at LEDGER_SCALE=8.
    // This is what proves the flat fee is captured: a unit-price-only
    // calculation would emit only 31 × 10^5 = 3_100_000.
    expect(db.outboxRows).toHaveLength(1)
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    expect(payload.amount).toBe(103_100_000)
    expect(payload.amount_scale).toBe(8)
    expect(payload.currency).toBe("EUR")
    expect(payload.value_after).toBe(31)
    expect(payload.delta).toBe(1)

    // LocalReservation deducts the full €1.031 from the allocation,
    // proving the wallet path also sees the flat fee, not just the unit rate.
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.consumedAmount).toBe(103_100_000)
  })

  it("prices subsequent in-tier events at only the per-unit rate (flat fee already accrued)", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    mockVolumeFlatTierPricing()

    // Engine reports 31 → 32 (already inside tier 2).
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 32 }]
      options?.beforePersist?.(facts)
      return facts
    })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 31,
      updatedAt: BASE_NOW - 1_000,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 10 * 100_000_000,
      // Flat fee was already deducted on the previous (boundary) event.
      consumedAmount: 103_100_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 250_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })
    db.grantWindowRows.set(`grant_123:onetime:${BASE_NOW - 60_000}`, {
      bucketKey: `grant_123:onetime:${BASE_NOW - 60_000}`,
      grantId: "grant_123",
      periodKey: `onetime:${BASE_NOW - 60_000}`,
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 31,
      exhaustedAt: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
      })
    )

    expect(result).toEqual({ allowed: true })

    // €0.001 = 100_000 minor units at scale-8. The flat fee is NOT charged
    // again — it accrued once at the 30→31 boundary. The diff approach
    // (price(after) − price(before)) is what makes this correct.
    expect(db.outboxRows).toHaveLength(1)
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    expect(payload.amount).toBe(100_000)
    expect(payload.value_after).toBe(32)

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.consumedAmount).toBe(103_100_000 + 100_000)
  })

  it("captures the flat fee when a single event jumps the customer from 0 straight into tier 2", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    mockVolumeFlatTierPricing()

    // Single event with delta=50 lands the customer straight in tier 2
    // without any prior tier-1 activity. The diff is price(50) − price(0).
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 50, meterKey: DEFAULT_METER_KEY, valueAfter: 50 }]
      options?.beforePersist?.(facts)
      return facts
    })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: "res_abc",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 250_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
      })
    )

    expect(result).toEqual({ allowed: true })

    // €1.05 = 50 × €0.001 + €1 flat = 1_050_000 × 100 = 105_000_000 minor
    // units at scale-8.
    expect(db.outboxRows).toHaveLength(1)
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    expect(payload.amount).toBe(105_000_000)
    expect(payload.delta).toBe(50)
  })

  it("does not bootstrap a reservation while the current event is still in the free tier", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    mockVolumeFlatTierPricing()

    // First event ever for this DO; bootstrap path runs because no
    // preWindow exists yet. Engine reports a tier-1 event (cost €0).
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_lazy",
        allocationAmount: 5 * 100_000_000,
        drainLegs: [],
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
      })
    )

    expect(result).toEqual({ allowed: true })
    expect(testState.createReservation).not.toHaveBeenCalled()

    expect(db.outboxRows).toHaveLength(1)
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    expect(payload.amount).toBe(0)
    expect(payload.value_after).toBe(1)
  })

  it("sizes the bootstrap reservation from the max marginal when the current event crosses into a paid tier", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    mockVolumeFlatTierPricing()

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "EUR",
      priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 30,
      updatedAt: BASE_NOW - 1_000,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      reservationId: null,
    })
    db.grantWindowRows.set(`grant_123:onetime:${BASE_NOW - 60_000}`, {
      bucketKey: `grant_123:onetime:${BASE_NOW - 60_000}`,
      grantId: "grant_123",
      periodKey: `onetime:${BASE_NOW - 60_000}`,
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 30,
      exhaustedAt: null,
    })

    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 31 }]
      options?.beforePersist?.(facts)
      return facts
    })

    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_lazy",
        allocationAmount: 5 * 100_000_000,
        drainLegs: [],
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
        event: { ...createApplyInput().event, properties: { amount: 1 } },
      })
    )

    expect(result).toEqual({ allowed: true })
    expect(testState.createReservation).toHaveBeenCalledTimes(1)

    const call = testState.createReservation.mock.calls[0]?.[0] as { requestedAmount: number }
    expect(call.requestedAmount).toBe(103_100_000_000)

    expect(db.outboxRows).toHaveLength(1)
    const payload = JSON.parse(db.outboxRows[0]!.payload)
    expect(payload.amount).toBe(103_100_000)
    expect(payload.value_after).toBe(31)
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

  vi.doMock("@unprice/observability", () => ({}))

  vi.doMock("~/observability", () => ({
    createDoLogger: vi.fn(() => testState.logger),
    runDoOperation: vi.fn(
      async <T>(_params: unknown, fn: (logger: typeof testState.logger) => Promise<T>) =>
        fn(testState.logger)
    ),
  }))

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

  // The DO lazy-instantiates a WalletService on first refill. We mock the
  // service and its ledger dep so tests can drive the flush outcome without a
  // real Postgres connection.
  vi.doMock("@unprice/services/ledger", () => ({
    LedgerGateway: class {},
  }))

  vi.doMock("@unprice/services/wallet", () => ({
    WalletService: class {
      public flushReservation = testState.flushReservation
      public createReservation = testState.createReservation
    },
  }))

  // sizeReservation lives in its own module specifically so the DO can
  // import it without pulling the use-cases barrel and its drizzle
  // relations chain. Mock with a tiny pure stub.
  vi.doMock("@unprice/services/wallet/reservation-sizing", () => ({
    sizeReservation: (price: number) => ({
      requestedAmount: Math.max(price * 1000, 100_000_000),
      refillThresholdBps: 2000,
      refillChunkAmount: Math.max(1, Math.floor(Math.max(price * 1000, 100_000_000) / 4)),
    }),
    MINIMUM_FLOOR_AMOUNT: 100_000_000,
    CEILING_AMOUNT: 1_000_000_000,
    DEFAULT_REFILL_THRESHOLD_BPS: 2000,
  }))

  vi.doMock("drizzle-orm", () => ({
    and: (...conditions: DrizzleCondition[]): DrizzleCondition => ({ kind: "and", conditions }),
    asc: (col: unknown) => ({ col, kind: "asc" }),
    desc: (col: unknown) => ({ col, kind: "desc" }),
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
    calculateCycleWindow: ({
      now,
      effectiveStartDate,
      effectiveEndDate,
    }: {
      now: number
      effectiveStartDate: number
      effectiveEndDate: number | null
    }) => {
      if (now < effectiveStartDate) return null
      if (typeof effectiveEndDate === "number" && now >= effectiveEndDate) return null
      return {
        start: effectiveStartDate,
        end: effectiveEndDate ?? Number.MAX_SAFE_INTEGER,
      }
    },
    calculatePricePerFeature: testState.pricePerFeature,
    configFeatureSchema: z.record(z.string(), z.unknown()),
    meterConfigSchema: z.record(z.string(), z.unknown()),
  }))

  vi.doMock("@unprice/services/entitlements", () => {
    class EventTimestampTooFarInFutureError extends Error {}
    class EventTimestampTooOldError extends Error {}

    const computeUsagePriceDeltaMinor = (params: {
      priceConfig: unknown
      usageAfter: number
      usageBefore: number
    }) => {
      const beforeResult = testState.pricePerFeature({
        quantity: Math.max(0, params.usageBefore),
        featureType: "usage",
        config: params.priceConfig,
      })
      if (beforeResult.err) throw beforeResult.err

      const afterResult = testState.pricePerFeature({
        quantity: Math.max(0, params.usageAfter),
        featureType: "usage",
        config: params.priceConfig,
      })
      if (afterResult.err) throw afterResult.err

      return diffLedgerMinor(afterResult.val.totalPrice.dinero, beforeResult.val.totalPrice.dinero)
    }

    const computeMaxMarginalPriceMinor = (priceConfig: {
      tiers?: Array<{ firstUnit?: number }>
    }) => {
      let maxMarginal = computeUsagePriceDeltaMinor({
        priceConfig,
        usageBefore: 0,
        usageAfter: 1,
      })

      for (const tier of priceConfig.tiers ?? []) {
        const firstUnit = tier.firstUnit
        if (typeof firstUnit !== "number" || firstUnit < 1) continue

        const crossing = computeUsagePriceDeltaMinor({
          priceConfig,
          usageBefore: firstUnit - 1,
          usageAfter: firstUnit,
        })
        if (crossing > maxMarginal) maxMarginal = crossing
      }

      return maxMarginal
    }

    const compareGrantDrainOrder = (
      left: { expiresAt: number | null; grantId: string; priority: number },
      right: { expiresAt: number | null; grantId: string; priority: number }
    ) =>
      right.priority - left.priority ||
      (left.expiresAt ?? Number.POSITIVE_INFINITY) -
        (right.expiresAt ?? Number.POSITIVE_INFINITY) ||
      left.grantId.localeCompare(right.grantId)

    const computeGrantPeriodBucket = (grant: {
      effectiveAt: number
      expiresAt: number | null
      grantId: string
      resetConfig?: { resetInterval: string } | null
    }) => {
      const interval = grant.resetConfig?.resetInterval ?? "onetime"
      const periodKey = `${interval}:${grant.effectiveAt}`
      return {
        bucketKey: `${grant.grantId}:${periodKey}`,
        periodKey,
        start: grant.effectiveAt,
        end: grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
      }
    }

    const validateGrantBatch = (
      grants: Array<{ currencyCode: string; meterHash: string }>
    ): void => {
      if (new Set(grants.map((grant) => grant.currencyCode)).size > 1) {
        throw new Error("Mixed-currency grants are not supported for one entitlement window")
      }

      if (new Set(grants.map((grant) => grant.meterHash)).size > 1) {
        throw new Error("Mixed meter hashes are not supported for one entitlement window")
      }
    }

    const resolveActiveGrants = <
      TGrant extends {
        effectiveAt: number
        expiresAt: number | null
        grantId: string
        priority: number
      },
    >(
      grants: TGrant[],
      timestamp: number
    ) =>
      grants
        .filter(
          (grant) =>
            grant.effectiveAt <= timestamp &&
            (grant.expiresAt === null || timestamp < grant.expiresAt)
        )
        .sort(compareGrantDrainOrder)

    const resolveGrantOverageStrategy = (grants: Array<{ overageStrategy: string }>) => {
      if (grants.some((grant) => grant.overageStrategy === "always")) return "always"
      if (grants.some((grant) => grant.overageStrategy === "last-call")) return "last-call"
      return "none"
    }

    const getGrantAllowance = (grant: { allowanceUnits?: number | null; amount?: number | null }) =>
      grant.allowanceUnits ?? grant.amount ?? null

    const resolveAvailableGrantUnits = (params: {
      grants: Array<{
        allowanceUnits: number | null
        effectiveAt: number
        expiresAt: number | null
        grantId: string
        resetConfig?: { resetInterval: string } | null
      }>
      states: GrantWindowRow[]
    }) => {
      const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
      let available = 0

      for (const grant of params.grants) {
        const allowanceUnits = getGrantAllowance(grant)
        if (allowanceUnits === null) return Number.POSITIVE_INFINITY

        const bucket = computeGrantPeriodBucket(grant)
        const consumed = statesByBucketKey.get(bucket.bucketKey)?.consumedInCurrentWindow ?? 0
        available += Math.max(0, allowanceUnits - consumed)
      }

      return available
    }

    const resolveConsumedGrantUnits = (params: {
      grants: Array<{
        effectiveAt: number
        expiresAt: number | null
        grantId: string
        resetConfig?: { resetInterval: string } | null
      }>
      states: GrantWindowRow[]
    }) => {
      const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
      return params.grants.reduce((total, grant) => {
        const bucket = computeGrantPeriodBucket(grant)
        return total + (statesByBucketKey.get(bucket.bucketKey)?.consumedInCurrentWindow ?? 0)
      }, 0)
    }

    const mergeGrantExpiry = (current: number | null, incoming: number | null) => {
      if (incoming === null) return current
      if (current === null) return incoming
      return Math.min(current, incoming)
    }

    return {
      AsyncMeterAggregationEngine: class {
        applyEventSync(event: unknown, options?: PersistOptions): Fact[] {
          return testState.engineApply(event, options) as Fact[]
        }
      },
      EventTimestampTooFarInFutureError,
      EventTimestampTooOldError,
      DO_IDEMPOTENCY_TTL_MS: TEST_DO_IDEMPOTENCY_TTL_MS,
      INGESTION_MAX_EVENT_AGE_MS: TEST_INGESTION_MAX_EVENT_AGE_MS,
      LATE_EVENT_GRACE_MS: TEST_LATE_EVENT_GRACE_MS,
      MAX_EVENT_AGE_MS: TEST_INGESTION_MAX_EVENT_AGE_MS,
      computeGrantPeriodBucket,
      computeMaxMarginalPriceMinor,
      computeUsagePriceDeltaMinor,
      deriveMeterKey: (m: {
        eventId: string
        eventSlug: string
        aggregationMethod: string
        aggregationField?: string
      }) => [m.eventId, m.eventSlug, m.aggregationMethod, m.aggregationField ?? ""].join(":"),
      consumeGrantsByPriority: (params: {
        grants: Array<{
          allowanceUnits: number | null
          effectiveAt: number
          expiresAt: number | null
          grantId: string
          priority: number
          resetConfig?: { resetInterval: string } | null
        }>
        states: GrantWindowRow[]
        timestamp: number
        units: number
      }) => {
        const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
        const grants = [...params.grants].sort(compareGrantDrainOrder)
        const allocations = []
        let remaining = params.units

        for (const grant of grants) {
          if (remaining <= 0) break
          const bucket = computeGrantPeriodBucket(grant)
          const state = statesByBucketKey.get(bucket.bucketKey) ?? {
            bucketKey: bucket.bucketKey,
            grantId: grant.grantId,
            periodKey: bucket.periodKey,
            periodStartAt: bucket.start,
            periodEndAt: bucket.end,
            consumedInCurrentWindow: 0,
            exhaustedAt: null,
          }
          const allowanceUnits = getGrantAllowance(grant)
          const available =
            allowanceUnits === null
              ? Number.POSITIVE_INFINITY
              : allowanceUnits - state.consumedInCurrentWindow
          if (available <= 0) continue
          const units = Math.min(remaining, available)
          const usageBefore = state.consumedInCurrentWindow
          const usageAfter = usageBefore + units
          allocations.push({
            grant,
            units,
            usageBefore,
            usageAfter,
            nextState: {
              ...state,
              consumedInCurrentWindow: usageAfter,
              exhaustedAt:
                allowanceUnits !== null && usageAfter >= allowanceUnits
                  ? params.timestamp
                  : state.exhaustedAt,
            },
            periodKey: state.periodKey,
          })
          statesByBucketKey.set(state.bucketKey, allocations.at(-1).nextState)
          remaining -= units
        }

        if (remaining > 0 && allocations.length > 0) {
          const previous = allocations[0]
          const usageBefore = previous.nextState.consumedInCurrentWindow
          const usageAfter = usageBefore + remaining
          allocations.push({
            grant: previous.grant,
            units: remaining,
            usageBefore,
            usageAfter,
            nextState: {
              ...previous.nextState,
              consumedInCurrentWindow: usageAfter,
              exhaustedAt:
                getGrantAllowance(previous.grant) !== null &&
                usageAfter >= (getGrantAllowance(previous.grant) ?? Number.POSITIVE_INFINITY)
                  ? params.timestamp
                  : previous.nextState.exhaustedAt,
            },
            periodKey: previous.nextState.periodKey,
          })
          remaining = 0
        }

        return { allocations, remaining }
      },
      mergeGrantExpiry,
      resolveActiveGrants,
      resolveAvailableGrantUnits,
      resolveConsumedGrantUnits,
      resolveGrantOverageStrategy,
      validateGrantBatch,
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
    entitlementConfigRows: new Map(),
    idempotencyRows: new Map(),
    outboxRows: [],
    meterWindowRows: new Map(),
    grantRows: new Map(),
    grantWindowRows: new Map(),
    deleteInArrayBatchSizes: [],
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
      const entitlementConfigSnapshot = new Map(state.entitlementConfigRows)
      const outboxSnapshot = [...state.outboxRows]
      const meterPricingSnapshot = new Map(state.meterWindowRows)
      const grantSnapshot = new Map(state.grantRows)
      const grantWindowSnapshot = new Map(state.grantWindowRows)
      const outboxIdSnapshot = nextOutboxId
      try {
        return callback(db)
      } catch (error) {
        state.idempotencyRows.clear()
        for (const [k, v] of Array.from(idempotencySnapshot.entries()))
          state.idempotencyRows.set(k, v)
        state.entitlementConfigRows.clear()
        for (const [k, v] of Array.from(entitlementConfigSnapshot.entries()))
          state.entitlementConfigRows.set(k, v)
        state.outboxRows.splice(0, state.outboxRows.length, ...outboxSnapshot)
        state.meterWindowRows.clear()
        for (const [k, v] of Array.from(meterPricingSnapshot.entries()))
          state.meterWindowRows.set(k, v)
        state.grantRows.clear()
        for (const [k, v] of Array.from(grantSnapshot.entries())) state.grantRows.set(k, v)
        state.grantWindowRows.clear()
        for (const [k, v] of Array.from(grantWindowSnapshot.entries()))
          state.grantWindowRows.set(k, v)
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
          if (keys.every((k) => ENTITLEMENT_CONFIG_KEYS.has(k))) {
            const source =
              cond?.value !== undefined
                ? state.entitlementConfigRows.get(String(cond.value))
                : state.entitlementConfigRows.values().next().value
            if (!source) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
            return row
          }
          if (keys.every((k) => METER_WINDOW_KEYS.has(k))) {
            // Single-meter DO → at most one meter_window row
            const first = state.meterWindowRows.values().next().value
            if (!first) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) {
              row[key] =
                key === "reservationEndAt"
                  ? (first.reservationEndAt ?? first.periodEndAt)
                  : (first as Record<string, unknown>)[key]
            }
            return row
          }
          if (keys.every((k) => GRANT_KEYS.has(k))) {
            const source =
              cond?.value !== undefined
                ? state.grantRows.get(String(cond.value))
                : state.grantRows.values().next().value
            if (!source) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
            return row
          }
          if (keys.every((k) => GRANT_WINDOW_KEYS.has(k))) {
            const source =
              cond?.value !== undefined
                ? state.grantWindowRows.get(String(cond.value))
                : state.grantWindowRows.values().next().value
            if (!source) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
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
          if (keys.every((k) => GRANT_WINDOW_KEYS.has(k))) {
            return [...state.grantWindowRows.values()]
              .sort((a, b) => a.grantId.localeCompare(b.grantId))
              .map((source) => {
                const row: Record<string, unknown> = {}
                for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
                return row
              })
          }
          if (keys.every((k) => GRANT_KEYS.has(k))) {
            return [...state.grantRows.values()]
              .sort((a, b) => a.grantId.localeCompare(b.grantId))
              .map((source) => {
                const row: Record<string, unknown> = {}
                for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
                return row
              })
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
              if ("customerEntitlementId" in value && "featureConfig" in value) {
                const key = String(value.customerEntitlementId)
                if (state.entitlementConfigRows.has(key)) return
                state.entitlementConfigRows.set(key, {
                  customerEntitlementId: key,
                  projectId: String(value.projectId),
                  customerId: String(value.customerId),
                  effectiveAt: Number(value.effectiveAt),
                  expiresAt: value.expiresAt != null ? Number(value.expiresAt) : null,
                  featureConfig: value.featureConfig,
                  featurePlanVersionId: String(value.featurePlanVersionId),
                  featureSlug: String(value.featureSlug),
                  meterConfig: value.meterConfig,
                  overageStrategy: String(value.overageStrategy),
                  resetConfig: value.resetConfig ?? null,
                  addedAt: Number(value.addedAt),
                  updatedAt: Number(value.updatedAt),
                })
                return
              }
              if ("bucketKey" in value && "consumedInCurrentWindow" in value) {
                const key = String(value.bucketKey)
                if (state.grantWindowRows.has(key)) return
                state.grantWindowRows.set(key, {
                  bucketKey: key,
                  grantId: String(value.grantId),
                  periodKey: String(value.periodKey),
                  periodStartAt: Number(value.periodStartAt),
                  periodEndAt: Number(value.periodEndAt),
                  consumedInCurrentWindow: Number(value.consumedInCurrentWindow ?? 0),
                  exhaustedAt: value.exhaustedAt != null ? Number(value.exhaustedAt) : null,
                })
                return
              }
              if ("grantId" in value && "allowanceUnits" in value) {
                const key = String(value.grantId)
                if (state.grantRows.has(key)) return
                state.grantRows.set(key, {
                  grantId: key,
                  allowanceUnits:
                    value.allowanceUnits != null ? Number(value.allowanceUnits) : null,
                  effectiveAt: Number(value.effectiveAt),
                  expiresAt: value.expiresAt != null ? Number(value.expiresAt) : null,
                  priority: Number(value.priority),
                  addedAt: Number(value.addedAt),
                })
                return
              }
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
                  currency: value.currency != null ? String(value.currency) : "",
                  priceConfig: value.priceConfig,
                  periodEndAt: value.periodEndAt != null ? Number(value.periodEndAt) : null,
                  reservationEndAt:
                    value.reservationEndAt != null ? Number(value.reservationEndAt) : null,
                  usage: value.usage != null ? Number(value.usage) : 0,
                  updatedAt: value.updatedAt != null ? Number(value.updatedAt) : null,
                  createdAt: Number(value.createdAt),
                  projectId: (value.projectId as string | null | undefined) ?? null,
                  customerId: (value.customerId as string | null | undefined) ?? null,
                })
                return
              }
              if ("id" in value && "currency" in value && "reservationEndAt" in value) {
                const key = DEFAULT_METER_KEY
                const existing = state.meterWindowRows.get(key)
                state.meterWindowRows.set(key, {
                  meterKey: key,
                  currency: String(value.currency),
                  priceConfig: existing?.priceConfig,
                  periodEndAt: existing?.periodEndAt ?? null,
                  reservationEndAt:
                    value.reservationEndAt != null ? Number(value.reservationEndAt) : null,
                  usage: existing?.usage ?? 0,
                  updatedAt: existing?.updatedAt ?? null,
                  createdAt: existing?.createdAt ?? BASE_NOW,
                  projectId: (value.projectId as string | null | undefined) ?? null,
                  customerId: (value.customerId as string | null | undefined) ?? null,
                  reservationId: existing?.reservationId ?? null,
                  allocationAmount: existing?.allocationAmount ?? 0,
                  consumedAmount: existing?.consumedAmount ?? 0,
                  flushedAmount: existing?.flushedAmount ?? 0,
                  refillThresholdBps: existing?.refillThresholdBps ?? 2000,
                  refillChunkAmount: existing?.refillChunkAmount ?? 0,
                  refillInFlight: existing?.refillInFlight ?? false,
                  flushSeq: existing?.flushSeq ?? 0,
                  pendingFlushSeq: existing?.pendingFlushSeq ?? null,
                  lastEventAt: existing?.lastEventAt ?? null,
                  lastFlushedAt: existing?.lastFlushedAt ?? null,
                  deletionRequested: existing?.deletionRequested ?? false,
                  recoveryRequired: existing?.recoveryRequired ?? false,
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
          let cond: DrizzleCondition | undefined
          return {
            where(c?: DrizzleCondition) {
              cond = c
              return this
            },
            run() {
              if ("consumedInCurrentWindow" in patch || "exhaustedAt" in patch) {
                const bucketKey = String(cond?.value ?? "")
                const row = state.grantWindowRows.get(bucketKey)
                if (!row) return
                Object.assign(row, patch)
                return
              }
              if ("expiresAt" in patch) {
                const id = String(cond?.value ?? "")
                const entitlement = state.entitlementConfigRows.get(id)
                if (entitlement) {
                  Object.assign(entitlement, patch)
                  return
                }
                const grant = state.grantRows.get(id)
                if (!grant) return
                Object.assign(grant, patch)
                return
              }
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
              const deleteValueCount = cond.values?.length ?? 0
              state.deleteInArrayBatchSizes.push(deleteValueCount)
              if (
                state.maxDeleteInArrayValues !== undefined &&
                deleteValueCount > state.maxDeleteInArrayValues
              ) {
                throw new Error("too many SQL variables")
              }
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

function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
  const amount =
    typeof overrides.allowanceUnits === "number"
      ? overrides.allowanceUnits
      : typeof overrides.amount === "number"
        ? overrides.amount
        : null

  return {
    allowanceUnits: amount,
    amount,
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: null,
    grantId: "grant_123",
    priority: 10,
    ...overrides,
  }
}

function createApplyInput(overrides: Record<string, unknown> = {}) {
  const projectId = (overrides.projectId as string | undefined) ?? "proj_123"
  const customerId = (overrides.customerId as string | undefined) ?? "cus_123"
  const customerEntitlementId = (overrides.customerEntitlementId as string | undefined) ?? "ce_123"
  const featurePlanVersionId =
    typeof overrides.featurePlanVersionId === "string" ? overrides.featurePlanVersionId : "fpv_123"
  const priceConfig =
    (overrides.priceConfig as typeof DEFAULT_PRICE_CONFIG | undefined) ?? DEFAULT_PRICE_CONFIG
  const meterConfig =
    (overrides.meterConfig as typeof DEFAULT_METER_CONFIG | undefined) ?? DEFAULT_METER_CONFIG
  const periodStartAt =
    typeof overrides.periodStartAt === "number" ? overrides.periodStartAt : BASE_NOW - 60_000
  const periodEndAt =
    typeof overrides.periodEndAt === "number" ? overrides.periodEndAt : BASE_NOW + 60_000
  const amount = typeof overrides.limit === "number" ? overrides.limit : null
  const overageStrategy =
    typeof overrides.overageStrategy === "string" ? overrides.overageStrategy : "none"
  const grantSnapshots = (overrides.grants as
    | ReturnType<typeof createGrantSnapshot>[]
    | undefined) ?? [
    createGrantSnapshot({
      amount,
      effectiveAt: periodStartAt,
      expiresAt: periodEndAt,
    }),
  ]
  const entitlementExpiresAt =
    "entitlementExpiresAt" in overrides
      ? (overrides.entitlementExpiresAt as number | null)
      : periodEndAt
  const entitlement = {
    customerEntitlementId,
    customerId,
    effectiveAt: periodStartAt,
    expiresAt: entitlementExpiresAt,
    featureConfig: priceConfig,
    featurePlanVersionId,
    featureSlug: (overrides.featureSlug as string | undefined) ?? "api_calls",
    featureType: (overrides.featureType as string | undefined) ?? "usage",
    meterConfig,
    overageStrategy,
    projectId,
    resetConfig: (overrides.resetConfig as Record<string, unknown> | null | undefined) ?? null,
    ...((overrides.entitlement as Record<string, unknown> | undefined) ?? {}),
  }

  return {
    customerId,
    entitlement,
    enforceLimit: (overrides.enforceLimit as boolean | undefined) ?? false,
    event: {
      id: "evt_123",
      properties: { amount: 3 },
      slug: "tokens_used",
      timestamp: BASE_NOW,
      ...((overrides.event as Record<string, unknown> | undefined) ?? {}),
    },
    idempotencyKey: (overrides.idempotencyKey as string | undefined) ?? "idem_123",
    now: (overrides.now as number | undefined) ?? BASE_NOW,
    projectId,
    grants: grantSnapshots.map((grant) => ({
      allowanceUnits:
        typeof grant.allowanceUnits === "number"
          ? grant.allowanceUnits
          : typeof grant.amount === "number"
            ? grant.amount
            : null,
      effectiveAt: Number(grant.effectiveAt),
      expiresAt: grant.expiresAt != null ? Number(grant.expiresAt) : null,
      grantId: String(grant.grantId),
      priority: Number(grant.priority),
    })),
  }
}
