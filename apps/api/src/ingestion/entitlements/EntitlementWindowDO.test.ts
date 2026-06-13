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
  meterFacts?: Record<string, unknown>[]
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
  billingPeriodId?: string | null
  cycleEndAt?: number | null
  cycleStartAt?: number | null
  featurePlanVersionItemId?: string | null
  featureSlug?: string | null
  statementKey?: string | null
  reservationId?: string | null
  allocationAmount?: number
  consumedAmount?: number
  flushedAmount?: number
  consumedQuantity?: number
  flushedQuantity?: number
  refillThresholdBps?: number
  refillChunkAmount?: number
  targetReservationAmount?: number
  spendEwmaAmount?: number
  lastRateSampledAtMs?: number | null
  maxEventCostAmount?: number
  pendingRefillAmount?: number
  pendingFlushAmount?: number | null
  pendingFlushQuantity?: number | null
  refillInFlight?: boolean
  flushSeq?: number
  pendingFlushSeq?: number | null
  pendingFlushFinal?: boolean
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

type PeriodUsageRow = {
  grantStatesJson: string
  periodEndAt: number
  periodKey: string
  periodStartAt: number
  updatedAt: number
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
  billingPeriods: unknown[]
  creditLinePolicy: string
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
  subscriptionItemId: string | null
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
  "billingPeriodId",
  "cycleEndAt",
  "cycleStartAt",
  "featurePlanVersionItemId",
  "featureSlug",
  "statementKey",
  "reservationId",
  "allocationAmount",
  "consumedAmount",
  "flushedAmount",
  "consumedQuantity",
  "flushedQuantity",
  "refillThresholdBps",
  "refillChunkAmount",
  "targetReservationAmount",
  "spendEwmaAmount",
  "lastRateSampledAtMs",
  "maxEventCostAmount",
  "pendingRefillAmount",
  "pendingFlushAmount",
  "pendingFlushQuantity",
  "refillInFlight",
  "flushSeq",
  "pendingFlushSeq",
  "pendingFlushFinal",
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

const PERIOD_USAGE_KEYS = new Set<string>([
  "periodKey",
  "periodStartAt",
  "periodEndAt",
  "grantStatesJson",
  "updatedAt",
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
  "billingPeriods",
  "creditLinePolicy",
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
  "subscriptionItemId",
  "addedAt",
  "updatedAt",
])

type FakeDbState = {
  entitlementConfigRows: Map<string, EntitlementConfigRow>
  idempotencyBatchRows: { id: number; createdAt: number; entries: string }[]
  outboxBatchRows: { id: number; payloads: string; currency: string; createdAt: number }[]
  meterWindowRows: Map<string, MeterWindowRow>
  grantRows: Map<string, GrantRow>
  grantWindowRows: Map<string, GrantWindowRow>
  periodUsageRows: Map<string, PeriodUsageRow>
  writeCounts: {
    idempotencyBatchRows: number
    outboxBatchRows: number
    grantWindowRows: number
    meterStateRows: number
    walletRows: number
  }
  deleteInArrayBatchSizes: number[]
  deleteOutboxRangeMaxIds: number[]
  storageReadCounts: {
    entitlementConfig: number
    grants: number
    grantWindows: number
  }
  failNextMeterWindowUpdate?: {
    matchKey: string
    error: Error
  }
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
  captureReservationUsage: vi.fn(),
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
    testState.captureReservationUsage.mockReset()
    testState.createReservation.mockReset()
    // Default: flush+refill settles with zero runway so tests that don't
    // opt into the wallet path stay identical to their pre-7.5 shape.
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: { grantedAmount: 0, flushedAmount: 0, refundedAmount: 0 },
    })
    // Default: lazy bootstrap returns a healthy reservation. Tests that need
    // the WALLET_EMPTY surface (allocationAmount: 0) or wallet-error paths
    // override this per-test.
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_lazy_default",
        allocationAmount: 1_000_000_000, // $10, the sizing ceiling
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

    expect(first).toMatchObject({ allowed: true })
    expect(second).toMatchObject({ allowed: true })
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(readIdempotencyEntries(db).size).toBe(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
    await Promise.all(state.waitUntilPromises)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)

    // priced payload surfaces ledger-scale amount + priced_at
    const payload = readOutboxPayloads(db)[0]!
    // 3 units @ $1.00 = $3.00 = 300_000_000 at LEDGER_SCALE (8)
    expect(payload.amount).toBe(300_000_000)
    expect(payload.amount_after).toBe(300_000_000)
    expect(payload.amount_scale).toBe(8)
    expect(payload.currency).toBe("USD")
    expect(payload.priced_at).toBe(BASE_NOW)
    expect(payload.feature_plan_version_id).toBe("fpv_123")
    expect(payload.tier_index).toBe(7)
    expect(payload.tier_mode).toBe("graduated")
    expect(payload.pricing_component_count).toBe(9)
  })

  it("deduplicates concurrent apply calls by idempotency key during wallet bootstrap", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const reservationStarted = createDeferred<void>()
    const reservationResult = createDeferred<{
      err: null
      val: {
        allocationAmount: number
        reservationId: string
      }
    }>()
    testState.createReservation.mockImplementation(async () => {
      reservationStarted.resolve()
      return await reservationResult.promise
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput()
    const first = durableObject.apply(input)

    await reservationStarted.promise
    const second = durableObject.apply(input)
    await Promise.resolve()

    expect(testState.createReservation).toHaveBeenCalledTimes(1)

    reservationResult.resolve({
      err: null,
      val: {
        reservationId: "res_concurrent_bootstrap",
        allocationAmount: 1_000_000_000,
      },
    })

    const results = await Promise.all([first, second])
    expect(results).toEqual([
      expect.objectContaining({ allowed: true }),
      expect.objectContaining({ allowed: true }),
    ])
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(readIdempotencyEntries(db).size).toBe(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(300_000_000)
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
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({
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

    expect(result).toMatchObject({ allowed: true })
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
  })

  it("resets monthly entitlement usage when the grant period changes", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const amount = (event as { properties: { amount: number } }).properties.amount
      const facts = [{ delta: amount, meterKey: DEFAULT_METER_KEY, valueAfter: amount }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodAStart = Date.UTC(2026, 0, 1)
    const periodBStart = Date.UTC(2026, 1, 1)
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({
      creditLinePolicy: "uncapped",
      enforceLimit: true,
      limit: 2,
      periodStartAt: periodAStart,
      periodEndAt: Date.UTC(2026, 2, 1),
      resetConfig: { resetInterval: "month", resetIntervalCount: 1 },
    })

    const periodA = await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_period_a",
        properties: { amount: 2 },
        timestamp: periodAStart + 1_000,
      },
      idempotencyKey: "idem_period_a",
      now: periodAStart + 1_000,
    })
    const periodB = await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_period_b",
        properties: { amount: 1 },
        timestamp: periodBStart,
      },
      idempotencyKey: "idem_period_b",
      now: periodBStart,
    })

    expect(periodA).toMatchObject({ allowed: true })
    expect(periodB).toMatchObject({ allowed: true })
    expect(periodA.meterFacts?.[0]?.period_key).toBe(`month:${periodAStart}`)
    expect(periodB.meterFacts?.[0]?.period_key).toBe(`month:${periodBStart}`)
    await expect(
      durableObject.getEnforcementState({
        entitlement: baseInput.entitlement,
        grants: baseInput.grants,
        now: periodBStart,
      })
    ).resolves.toMatchObject({ isLimitReached: false, limit: 2, usage: 1 })
  })

  it("assigns boundary events to the correct entitlement period", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodAStart = Date.UTC(2026, 0, 1)
    const periodBStart = Date.UTC(2026, 1, 1)
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({
      creditLinePolicy: "uncapped",
      limit: 10,
      periodStartAt: periodAStart,
      periodEndAt: Date.UTC(2026, 2, 1),
      resetConfig: { resetInterval: "month", resetIntervalCount: 1 },
    })

    const oldPeriod = await durableObject.apply({
      ...baseInput,
      event: { ...baseInput.event, id: "evt_old_boundary", timestamp: periodBStart - 1 },
      idempotencyKey: "idem_old_boundary",
      now: periodBStart - 1,
    })
    const newPeriod = await durableObject.apply({
      ...baseInput,
      event: { ...baseInput.event, id: "evt_new_boundary", timestamp: periodBStart },
      idempotencyKey: "idem_new_boundary",
      now: periodBStart,
    })

    expect(oldPeriod.meterFacts?.[0]).toMatchObject({
      amount_after: 100_000_000,
      period_key: `month:${periodAStart}`,
      value_after: 1,
    })
    expect(newPeriod.meterFacts?.[0]).toMatchObject({
      amount_after: 100_000_000,
      period_key: `month:${periodBStart}`,
      value_after: 1,
    })
  })

  it("keeps late old-period usage isolated from current-period enforcement", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const amount = (event as { properties: { amount: number } }).properties.amount
      const facts = [{ delta: amount, meterKey: DEFAULT_METER_KEY, valueAfter: amount }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodAStart = Date.UTC(2026, 0, 1)
    const periodBStart = Date.UTC(2026, 1, 1)
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({
      creditLinePolicy: "uncapped",
      limit: 10,
      periodStartAt: periodAStart,
      periodEndAt: Date.UTC(2026, 2, 1),
      resetConfig: { resetInterval: "month", resetIntervalCount: 1 },
    })

    await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_current_period",
        properties: { amount: 1 },
        timestamp: periodBStart,
      },
      idempotencyKey: "idem_current_period",
      now: periodBStart,
    })
    const lateOldPeriod = await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_late_old_period",
        properties: { amount: 3 },
        timestamp: periodBStart - 1,
      },
      idempotencyKey: "idem_late_old_period",
      now: periodBStart + TEST_LATE_EVENT_GRACE_MS,
    })
    const tooLate = await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_too_late_old_period",
        properties: { amount: 3 },
        timestamp: periodBStart - 1,
      },
      idempotencyKey: "idem_too_late_old_period",
      now: periodBStart + TEST_LATE_EVENT_GRACE_MS + 1,
    })

    expect(lateOldPeriod).toMatchObject({ allowed: true })
    expect(lateOldPeriod.meterFacts?.[0]?.period_key).toBe(`month:${periodAStart}`)
    expect(tooLate).toMatchObject({
      allowed: false,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })
    expect(tooLate.meterFacts).toBeUndefined()
    await expect(
      durableObject.getEnforcementState({
        entitlement: baseInput.entitlement,
        grants: baseInput.grants,
        now: periodBStart,
      })
    ).resolves.toMatchObject({ usage: 1 })
  })

  it("replays old-period idempotency after the next period without mutating current usage", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const amount = (event as { properties: { amount: number } }).properties.amount
      const facts = [{ delta: amount, meterKey: DEFAULT_METER_KEY, valueAfter: amount }]
      options?.beforePersist?.(facts)
      return facts
    })

    const periodAStart = Date.UTC(2026, 0, 1)
    const periodBStart = Date.UTC(2026, 1, 1)
    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({
      creditLinePolicy: "uncapped",
      periodStartAt: periodAStart,
      periodEndAt: Date.UTC(2026, 2, 1),
      resetConfig: { resetInterval: "month", resetIntervalCount: 1 },
    })
    const periodAInput = {
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_replay_old_period",
        properties: { amount: 2 },
        timestamp: periodAStart + 1_000,
      },
      idempotencyKey: "idem_replay_old_period",
      now: periodAStart + 1_000,
    }

    const original = await durableObject.apply(periodAInput)
    await durableObject.apply({
      ...baseInput,
      event: {
        ...baseInput.event,
        id: "evt_replay_current_period",
        properties: { amount: 1 },
        timestamp: periodBStart,
      },
      idempotencyKey: "idem_replay_current_period",
      now: periodBStart,
    })
    const replay = await durableObject.apply({ ...periodAInput, now: periodBStart })

    expect(replay).toEqual(original)
    expect(testState.engineApply).toHaveBeenCalledTimes(2)
    await expect(
      durableObject.getEnforcementState({
        entitlement: baseInput.entitlement,
        grants: baseInput.grants,
        now: periodBStart,
      })
    ).resolves.toMatchObject({ usage: 1 })
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
    const total = readOutboxPayloads(db).reduce((acc, payload) => acc + Number(payload.amount), 0)
    expect(total).toBe(EVENT_COUNT * 300)
  })

  it("limits hot-path grant window reads to the active bucket", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const activeBucketKey = `grant_123:onetime:${BASE_NOW - 60_000}`
    db.grantWindowRows.set(activeBucketKey, {
      bucketKey: activeBucketKey,
      grantId: "grant_123",
      periodKey: `onetime:${BASE_NOW - 60_000}`,
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 2,
      exhaustedAt: null,
    })

    for (let i = 0; i < 250; i++) {
      const bucketKey = `grant_historical_${i}:onetime:${BASE_NOW - (i + 2) * 60_000}`
      db.grantWindowRows.set(bucketKey, {
        bucketKey,
        grantId: `grant_historical_${i}`,
        periodKey: `onetime:${BASE_NOW - (i + 2) * 60_000}`,
        periodStartAt: BASE_NOW - (i + 2) * 60_000,
        periodEndAt: BASE_NOW - (i + 1) * 60_000,
        consumedInCurrentWindow: 100,
        exhaustedAt: BASE_NOW - (i + 1) * 60_000,
      })
    }

    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })
    db.storageReadCounts.grantWindows = 0

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        enforceLimit: true,
        limit: 10,
      })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(db.storageReadCounts.grantWindows).toBe(2)
    expect(db.grantWindowRows.get(activeBucketKey)?.consumedInCurrentWindow).toBe(5)
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
    expect(readIdempotencyEntries(db).size).toBe(1)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    await Promise.all(state.waitUntilPromises)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
  })

  it("allows the last call that crosses a hard limit, then denies the next call", async () => {
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
      consumedInCurrentWindow: 8,
      exhaustedAt: null,
    })
    testState.engineApply
      .mockImplementationOnce((_event: unknown, options?: PersistOptions) => {
        const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 13 }]
        options?.beforePersist?.(facts)
        return facts
      })
      .mockImplementationOnce((_event: unknown, options?: PersistOptions) => {
        const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 14 }]
        options?.beforePersist?.(facts)
        return facts
      })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const crossing = await durableObject.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        enforceLimit: true,
        limit: 10,
        overageStrategy: "last-call",
      })
    )
    const afterLimit = await durableObject.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        enforceLimit: true,
        idempotencyKey: "idem_after_limit",
        event: { ...createApplyInput().event, id: "evt_after_limit" },
        limit: 10,
        overageStrategy: "last-call",
      })
    )

    expect(crossing).toMatchObject({ allowed: true })
    expect(afterLimit).toEqual({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: expect.stringContaining(DEFAULT_METER_KEY),
    })
    expect(readOutboxPayloads(db)).toHaveLength(2)
    expect(db.grantWindowRows.get(`grant_123:onetime:${BASE_NOW - 60_000}`)).toMatchObject({
      consumedInCurrentWindow: 13,
      exhaustedAt: BASE_NOW,
    })
  })

  it("treats always overage as a soft limit during apply", async () => {
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
      consumedInCurrentWindow: 10,
      exhaustedAt: BASE_NOW - 1,
    })
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 15 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        creditLinePolicy: "uncapped",
        enforceLimit: true,
        limit: 10,
        overageStrategy: "always",
      })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({ allowed: true })
  })

  it("closes an active reservation asynchronously when ingestion rejects on limit", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    db.grantWindowRows.set("grant_123:onetime:1773921540000", {
      bucketKey: "grant_123:onetime:1773921540000",
      grantId: "grant_123",
      periodKey: "onetime:1773921540000",
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 6,
      exhaustedAt: null,
    })
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      reservationEndAt: BASE_NOW + 60_000,
      usage: 6,
      updatedAt: BASE_NOW,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_limit",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 2 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 100_000_000,
      refillInFlight: false,
      flushSeq: 2,
      pendingFlushSeq: null,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 30_000,
      deletionRequested: false,
      recoveryRequired: false,
    })
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 11 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        enforceLimit: true,
        limit: 10,
      })
    )

    expect(result).toEqual({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: expect.stringContaining(DEFAULT_METER_KEY),
    })
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_limit",
        flushSeq: 3,
        flushAmount: 3 * 100_000_000,
        refillChunkAmount: 0,
        final: true,
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      reservationId: null,
    })
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
      expect(readIdempotencyEntries(db).size).toBe(0)
      expect(readOutboxPayloads(db)).toHaveLength(0)
      expect(state.alarmAt).toBeNull()
      vi.resetModules()
      testState.engineApply.mockReset()
    }
  })

  it("logs one summary for applyBatch instead of one apply log per event", async () => {
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
    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: baseInput.enforceLimit,
      events: [
        {
          ...baseInput.event,
          correlationKey: "batch_1",
          id: "evt_batch_1",
          idempotencyKey: "idem_batch_1",
          now: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "batch_2",
          id: "evt_batch_2",
          idempotencyKey: "idem_batch_2",
          now: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({
        allowed: true,
        correlationKey: "batch_1",
        idempotencyKey: "idem_batch_1",
      }),
      expect.objectContaining({
        allowed: true,
        correlationKey: "batch_2",
        idempotencyKey: "idem_batch_2",
      }),
    ])
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(JSON.parse(db.idempotencyBatchRows[0]!.entries)).toHaveLength(2)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(2)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(testState.logger.info).not.toHaveBeenCalledWith("entitlement apply", expect.anything())
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        event_count: 2,
        reservation_action: "none",
        processed_count: 2,
        allowed_count: 2,
        denied_count: 0,
        outcome: "success",
      })
    )
  })

  it("retries applyBatch after a pre-commit failure without partial durable writes", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    let failSecondEvent = true
    testState.db = db
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const eventId = (event as { id: string }).id
      if (eventId === "evt_batch_2" && failSecondEvent) {
        throw new Error("ENGINE_DOWN")
      }

      const facts = [
        {
          delta: 1,
          meterKey: DEFAULT_METER_KEY,
          valueAfter: eventId === "evt_batch_1" ? 1 : 2,
        },
      ]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const batchInput = {
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: baseInput.enforceLimit,
      events: [
        {
          ...baseInput.event,
          correlationKey: "batch_1",
          id: "evt_batch_1",
          idempotencyKey: "idem_batch_1",
          now: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "batch_2",
          id: "evt_batch_2",
          idempotencyKey: "idem_batch_2",
          now: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    }

    await expect(durableObject.applyBatch(batchInput)).rejects.toThrow("ENGINE_DOWN")
    expect(readIdempotencyEntry(db, "idem_batch_1")).toBeUndefined()
    expect(db.idempotencyBatchRows).toHaveLength(0)
    expect(readIdempotencyEntry(db, "idem_batch_2")).toBeUndefined()

    failSecondEvent = false
    const retry = await durableObject.applyBatch(batchInput)

    expect(retry.results).toEqual([
      expect.objectContaining({
        allowed: true,
        correlationKey: "batch_1",
        idempotencyKey: "idem_batch_1",
      }),
      expect.objectContaining({
        allowed: true,
        correlationKey: "batch_2",
        idempotencyKey: "idem_batch_2",
      }),
    ])
    expect(testState.engineApply.mock.calls.map(([event]) => (event as { id: string }).id)).toEqual(
      ["evt_batch_1", "evt_batch_2", "evt_batch_1", "evt_batch_2"]
    )
    expect(db.idempotencyBatchRows).toHaveLength(1)
  })

  it("uses compact async batch rows for idempotency and returned meter facts", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const index = Number(String((event as { id: string }).id).replace("evt_batch_", ""))
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: index + 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const events = Array.from({ length: 100 }, (_, index) => ({
      ...baseInput.event,
      correlationKey: `batch_${index}`,
      id: `evt_batch_${index}`,
      idempotencyKey: `idem_batch_${index}`,
      now: BASE_NOW + index,
      timestamp: BASE_NOW + index,
    }))

    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events,
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toHaveLength(100)
    expect(db.writeCounts.idempotencyBatchRows).toBe(1)
    expect(db.writeCounts.outboxBatchRows).toBe(0)
    // The test engine is mocked and returns facts directly, so it does not
    // touch the meter-state adapter. The production path adds one insert and
    // one final update when the meter row is new.
    expect(db.writeCounts.meterStateRows).toBe(0)
    expect(db.writeCounts.grantWindowRows).toBe(1)
    expect(db.writeCounts.walletRows).toBe(0)
    expect(JSON.parse(db.idempotencyBatchRows[0]!.entries)).toHaveLength(100)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(100)

    const compactWrites =
      db.writeCounts.idempotencyBatchRows +
      db.writeCounts.outboxBatchRows +
      db.writeCounts.meterStateRows +
      db.writeCounts.grantWindowRows +
      db.writeCounts.walletRows
    const compactWriteSiteModel = compactWrites + 2
    const perEventWriteModel = 100 * 4
    expect(compactWrites).toBe(2)
    expect(compactWriteSiteModel).toBe(4)
    expect(compactWriteSiteModel).toBeLessThanOrEqual(perEventWriteModel / 10)
    await Promise.all(state.waitUntilPromises)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        duplicate_count: 0,
        priced_fact_count: 100,
        grant_allocation_count: 100,
        meter_state_write_count: 0,
        grant_window_write_count: 1,
        wallet_reservation_write_count: 0,
        outbox_insert_count: 0,
        outbox_fact_count: 0,
        idempotency_insert_count: 1,
        idempotency_event_count: 100,
      })
    )
  })

  it("keeps compact write shape after optimized reservation growth retry", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_compact_retry",
      allocationAmount: 50_000_000,
      targetReservationAmount: 50_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 2_000_000_000,
        flushedAmount: 0,
        refundedAmount: 0,
      },
    })
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const index = Number(String((event as { id: string }).id).replace("evt_retry_", ""))
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: index + 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...baseInput.event,
      correlationKey: `retry_${index}`,
      id: `evt_retry_${index}`,
      idempotencyKey: `idem_retry_${index}`,
      now: BASE_NOW + index,
      properties: { amount: 1 },
      timestamp: BASE_NOW + index,
    }))

    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events,
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toHaveLength(10)
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(10)
    expect(db.writeCounts.idempotencyBatchRows).toBe(1)
    expect(db.writeCounts.walletRows).toBeLessThanOrEqual(3)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        reservation_action: "refilled",
        idempotency_insert_count: 1,
        idempotency_event_count: 10,
      })
    )
  })

  it("preserves wallet consumption while compacting an already-funded async batch", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_batch",
      allocationAmount: 20 * 100_000_000,
      targetReservationAmount: 20 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const index = Number(String((event as { id: string }).id).replace("evt_wallet_", ""))
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: index + 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const events = Array.from({ length: 5 }, (_, index) => ({
      ...baseInput.event,
      correlationKey: `wallet_${index}`,
      id: `evt_wallet_${index}`,
      idempotencyKey: `idem_wallet_${index}`,
      now: BASE_NOW + index,
      timestamp: BASE_NOW + index,
    }))

    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events,
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toHaveLength(5)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(5 * 100_000_000)
    expect(db.writeCounts.walletRows).toBe(1)
    expect(db.writeCounts.idempotencyBatchRows).toBe(1)
    expect(db.writeCounts.outboxBatchRows).toBe(0)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(5)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 0,
        batch_wallet_underfunded_retry_count: 0,
      })
    )
  })

  it("retries optimized batch after lazy wallet bootstrap", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: {
        totalPrice: {
          dinero: fakeDinero(Math.max(0, quantity - 1) * 100, 2),
        },
      },
    }))
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const valueAfter = (event as { id: string }).id === "evt_paid" ? 2 : 1
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "free",
          id: "evt_free",
          idempotencyKey: "idem_free",
          now: BASE_NOW,
          properties: { amount: 1 },
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "paid",
          id: "evt_paid",
          idempotencyKey: "idem_paid",
          now: BASE_NOW + 1,
          properties: { amount: 1 },
          timestamp: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "free" }),
      expect.objectContaining({ allowed: true, correlationKey: "paid" }),
    ])
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(2)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        reservation_action: "bootstrapped",
        processed_count: 2,
        outcome: "success",
      })
    )
  })

  it("keeps optimized batch compact and closes reservation after staged limit denial", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_limit_batch",
      allocationAmount: 10 * 100_000_000,
      targetReservationAmount: 10 * 100_000_000,
    })
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const valueAfter = (event as { id: string }).id === "evt_limit_second" ? 2 : 1
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({ enforceLimit: true, limit: 1 })
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: true,
      events: [
        {
          ...baseInput.event,
          correlationKey: "first",
          id: "evt_limit_first",
          idempotencyKey: "idem_limit_first",
          now: BASE_NOW,
          properties: { amount: 1 },
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "second",
          id: "evt_limit_second",
          idempotencyKey: "idem_limit_second",
          now: BASE_NOW + 1,
          properties: { amount: 1 },
          timestamp: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })
    await Promise.all(state.waitUntilPromises)

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "first" }),
      expect.objectContaining({
        allowed: false,
        correlationKey: "second",
        deniedReason: "LIMIT_EXCEEDED",
      }),
    ])
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(1)
    await Promise.all(state.waitUntilPromises)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        final: true,
        reservationId: "res_limit_batch",
      })
    )
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({ outcome: "success" })
    )
  })

  it("keeps optimized batch writes bounded for mixed allowed denied and duplicate events", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_mixed_compact_batch",
      allocationAmount: 20 * 100_000_000,
      targetReservationAmount: 20 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const eventId = (event as { id: string }).id
      const valueAfter = eventId === "evt_mixed_limit" ? 30 : 1
      const facts = [{ delta: valueAfter, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({ enforceLimit: true, limit: 25 })
    const first = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: true,
      events: [
        {
          ...baseInput.event,
          correlationKey: "allowed",
          id: "evt_mixed_allowed",
          idempotencyKey: "idem_mixed_allowed",
          now: BASE_NOW,
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "limit",
          id: "evt_mixed_limit",
          idempotencyKey: "idem_mixed_limit",
          now: BASE_NOW + 1,
          timestamp: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(first.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "allowed" }),
      expect.objectContaining({
        allowed: false,
        correlationKey: "limit",
        deniedReason: "LIMIT_EXCEEDED",
      }),
    ])

    const second = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: true,
      events: [
        {
          ...baseInput.event,
          correlationKey: "allowed_replay",
          id: "evt_mixed_allowed_replay",
          idempotencyKey: "idem_mixed_allowed",
          now: BASE_NOW + 2,
          timestamp: BASE_NOW + 2,
        },
        {
          ...baseInput.event,
          correlationKey: "new_allowed",
          id: "evt_mixed_new_allowed",
          idempotencyKey: "idem_mixed_new_allowed",
          now: BASE_NOW + 3,
          timestamp: BASE_NOW + 3,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(second.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "allowed_replay" }),
      expect.objectContaining({ allowed: true, correlationKey: "new_allowed" }),
    ])
    expect(db.idempotencyBatchRows).toHaveLength(2)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(2)
    expect(db.writeCounts.outboxBatchRows).toBe(0)
    expect(db.writeCounts.idempotencyBatchRows).toBe(2)
    expect(db.writeCounts.walletRows).toBeLessThanOrEqual(7)
  })

  it("retries optimized batch after growing an underfunded wallet reservation", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_underfunded_batch",
      allocationAmount: 500_000_000,
      targetReservationAmount: 500_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 2_000_000_000,
        flushedAmount: 100_000_000,
        refundedAmount: 0,
      },
    })
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const isSecond = (event as { id: string }).id === "evt_underfunded_second"
      const facts = [
        {
          delta: isSecond ? 10 : 1,
          meterKey: DEFAULT_METER_KEY,
          valueAfter: isSecond ? 11 : 1,
        },
      ]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "first",
          id: "evt_underfunded_first",
          idempotencyKey: "idem_underfunded_first",
          now: BASE_NOW,
          properties: { amount: 1 },
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "second",
          id: "evt_underfunded_second",
          idempotencyKey: "idem_underfunded_second",
          now: BASE_NOW + 1,
          properties: { amount: 10 },
          timestamp: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "first" }),
      expect.objectContaining({ allowed: true, correlationKey: "second" }),
    ])
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        final: false,
        flushAmount: 0,
        reservationId: "res_underfunded_batch",
      })
    )
    const wallet = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(wallet?.consumedAmount).toBe(1_100_000_000)
    expect(wallet?.allocationAmount).toBeGreaterThanOrEqual(2_500_000_000)
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(2)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        reservation_action: "refilled",
        outcome: "success",
      })
    )
  })

  it("grows optimized batch when staged spend makes the reservation underfunded", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_staged_batch_headroom",
      allocationAmount: 5 * 100_000_000,
      targetReservationAmount: 5 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockImplementation(
      async (input: { flushAmount: number; refillChunkAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: input.refillChunkAmount,
          flushedAmount: input.flushAmount,
          refundedAmount: 0,
        },
      })
    )
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const amount = Number((event as { properties: { amount: number } }).properties.amount)
      const valueAfter = (event as { id: string }).id === "evt_staged_second" ? 6 : 3
      const facts = [{ delta: amount, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "first",
          id: "evt_staged_first",
          idempotencyKey: "idem_staged_first",
          now: BASE_NOW,
          properties: { amount: 3 },
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "second",
          id: "evt_staged_second",
          idempotencyKey: "idem_staged_second",
          now: BASE_NOW + 1,
          properties: { amount: 3 },
          timestamp: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "first" }),
      expect.objectContaining({ allowed: true, correlationKey: "second" }),
    ])
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        final: false,
        flushAmount: 0,
        reservationId: "res_staged_batch_headroom",
      })
    )
    expect(testState.flushReservation.mock.calls[0]?.[0].refillChunkAmount).toBeGreaterThan(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.allocationAmount).toBeGreaterThan(
      5 * 100_000_000
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(6 * 100_000_000)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(2)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 0,
        batch_wallet_underfunded_event_ids: ["evt_staged_second"],
        batch_wallet_underfunded_last_event_id: "evt_staged_second",
        batch_wallet_underfunded_last_meter_slug: "tokens_used",
        batch_wallet_underfunded_last_remaining_amount: 200_000_000,
        batch_wallet_underfunded_last_required_headroom_amount: 600_000_000,
        batch_wallet_underfunded_refill_outcomes: ["refilled"],
        batch_wallet_underfunded_retry_count: 1,
        reservation_action: "refilled",
      })
    )
  })

  it("denies optimized batch with WALLET_EMPTY when sync refill cannot fund the event", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_batch_empty",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 2 * 100_000_000 - 10,
      targetReservationAmount: 10 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockImplementation(
      async (input: { final: boolean; flushAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: 0,
          flushedAmount: input.flushAmount,
          refundedAmount: input.final ? 10 : 0,
        },
      })
    )
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "wallet_empty",
          id: "evt_batch_empty",
          idempotencyKey: "idem_batch_empty",
          now: BASE_NOW,
          properties: { amount: 3 },
          timestamp: BASE_NOW,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      {
        allowed: false,
        correlationKey: "wallet_empty",
        deniedReason: "WALLET_EMPTY",
        idempotencyKey: "idem_batch_empty",
        message: "Wallet empty for meter tokens_used (reservation res_batch_empty)",
      },
    ])
    expect(readIdempotencyEntry(db, "idem_batch_empty")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(readIdempotencyMeterFacts(db)).toHaveLength(0)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        final: false,
        flushAmount: 2 * 100_000_000 - 10,
        reservationId: "res_batch_empty",
      })
    )
    await Promise.all(state.waitUntilPromises)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        final: true,
        flushAmount: 0,
        reservationId: "res_batch_empty",
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 1,
        batch_wallet_empty_after_refill_event_ids: ["evt_batch_empty"],
        batch_wallet_empty_after_refill_last_event_id: "evt_batch_empty",
        batch_wallet_empty_after_refill_last_remaining_amount: 10,
        batch_wallet_empty_after_refill_last_required_amount: 300_000_000,
        batch_wallet_underfunded_event_ids: ["evt_batch_empty"],
        batch_wallet_underfunded_refill_outcomes: ["refilled"],
        batch_wallet_underfunded_retry_count: 1,
        denied_by_reason: { WALLET_EMPTY: 1 },
      })
    )
  })

  it("denies optimized batch with WALLET_EMPTY when sync refill is partial and still insufficient", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_batch_partial_empty",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 2 * 100_000_000 - 10,
      targetReservationAmount: 10 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockImplementation(
      async (input: { final: boolean; flushAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: input.final ? 0 : 100_000_000,
          flushedAmount: input.flushAmount,
          refundedAmount: input.final ? 10 : 0,
        },
      })
    )
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "partial_wallet_empty",
          id: "evt_batch_partial_empty",
          idempotencyKey: "idem_batch_partial_empty",
          now: BASE_NOW,
          properties: { amount: 3 },
          timestamp: BASE_NOW,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({
        allowed: false,
        correlationKey: "partial_wallet_empty",
        deniedReason: "WALLET_EMPTY",
        idempotencyKey: "idem_batch_partial_empty",
      }),
    ])
    expect(readIdempotencyEntry(db, "idem_batch_partial_empty")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(readIdempotencyMeterFacts(db)).toHaveLength(0)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    await Promise.all(state.waitUntilPromises)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement flush_refill",
      expect.objectContaining({
        reservation_refill_partial: true,
        reservation_refill_granted_amount: 100_000_000,
      })
    )
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 1,
        batch_wallet_empty_after_refill_event_ids: ["evt_batch_partial_empty"],
        batch_wallet_empty_after_refill_last_remaining_amount: 100_000_010,
        batch_wallet_empty_after_refill_last_required_amount: 300_000_000,
        batch_wallet_underfunded_event_ids: ["evt_batch_partial_empty"],
        batch_wallet_underfunded_refill_outcomes: ["refilled"],
        batch_wallet_underfunded_retry_count: 1,
        denied_by_reason: { WALLET_EMPTY: 1 },
      })
    )
  })

  it("denies optimized batch with WALLET_EMPTY when batch headroom exceeds max outstanding", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_batch_max_outstanding",
      allocationAmount: 30 * 100_000_000,
      targetReservationAmount: 30 * 100_000_000,
      maxEventCostAmount: 10 * 100_000_000,
    })
    testState.flushReservation.mockImplementation(async (input: { flushAmount: number }) => ({
      err: null,
      val: {
        grantedAmount: 0,
        flushedAmount: input.flushAmount,
        refundedAmount: 0,
      },
    }))
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const index = Number(String((event as { id: string }).id).replace("evt_batch_cap_", ""))
      const valueAfter = (index + 1) * 10
      const facts = [{ delta: 10, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: Array.from({ length: 4 }, (_, index) => ({
        ...baseInput.event,
        correlationKey: `cap_${index}`,
        id: `evt_batch_cap_${index}`,
        idempotencyKey: `idem_batch_cap_${index}`,
        now: BASE_NOW + index,
        properties: { amount: 10 },
        timestamp: BASE_NOW + index,
      })),
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "cap_0" }),
      expect.objectContaining({ allowed: true, correlationKey: "cap_1" }),
      expect.objectContaining({ allowed: true, correlationKey: "cap_2" }),
      expect.objectContaining({
        allowed: false,
        correlationKey: "cap_3",
        deniedReason: "WALLET_EMPTY",
        idempotencyKey: "idem_batch_cap_3",
      }),
    ])
    expect(readIdempotencyEntry(db, "idem_batch_cap_3")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(readIdempotencyMeterFacts(db)).toHaveLength(3)
    expect(db.outboxBatchRows).toHaveLength(0)
    await Promise.all(state.waitUntilPromises)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 1,
        batch_wallet_empty_after_refill_event_ids: ["evt_batch_cap_3"],
        batch_wallet_empty_after_refill_last_remaining_amount: 0,
        batch_wallet_empty_after_refill_last_remaining_amount_display: "$0",
        batch_wallet_empty_after_refill_last_required_amount: 1_000_000_000,
        batch_wallet_empty_after_refill_last_required_amount_display: "$10",
        batch_wallet_underfunded_event_ids: ["evt_batch_cap_3"],
        batch_wallet_underfunded_last_effective_cost_amount_display: "$10",
        batch_wallet_underfunded_last_remaining_amount_display: "$0",
        batch_wallet_underfunded_last_required_headroom_amount: 4_000_000_000,
        batch_wallet_underfunded_last_required_headroom_amount_display: "$40",
        batch_wallet_underfunded_last_staged_consumed_amount_display: "$30",
        batch_wallet_underfunded_refill_outcomes: ["max_outstanding_reached"],
        batch_wallet_underfunded_retry_count: 1,
        currency: "USD",
        denied_by_reason: { WALLET_EMPTY: 1 },
        outcome: "success",
      })
    )
  })

  it("bounds optimized batch retries when multiple later events need reservation growth", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      reservationId: "res_batch_multi_grow",
      allocationAmount: 2 * 100_000_000,
      targetReservationAmount: 2 * 100_000_000,
      maxEventCostAmount: 100_000_000,
    })
    testState.flushReservation.mockImplementation(async (input: { flushAmount: number }) => ({
      err: null,
      val: {
        grantedAmount: 2 * 100_000_000,
        flushedAmount: input.flushAmount,
        refundedAmount: 0,
      },
    }))
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const eventId = (event as { id: string }).id
      const valueAfter = eventId === "evt_multi_first" ? 2 : eventId === "evt_multi_second" ? 4 : 6
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput()
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "first",
          id: "evt_multi_first",
          idempotencyKey: "idem_multi_first",
          now: BASE_NOW,
          properties: { amount: 2 },
          timestamp: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "second",
          id: "evt_multi_second",
          idempotencyKey: "idem_multi_second",
          now: BASE_NOW + 1,
          properties: { amount: 2 },
          timestamp: BASE_NOW + 1,
        },
        {
          ...baseInput.event,
          correlationKey: "third",
          id: "evt_multi_third",
          idempotencyKey: "idem_multi_third",
          now: BASE_NOW + 2,
          properties: { amount: 2 },
          timestamp: BASE_NOW + 2,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({ allowed: true, correlationKey: "first" }),
      expect.objectContaining({ allowed: true, correlationKey: "second" }),
      expect.objectContaining({ allowed: true, correlationKey: "third" }),
    ])
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        final: false,
        reservationId: "res_batch_multi_grow",
      })
    )
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        final: false,
        reservationId: "res_batch_multi_grow",
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(6 * 100_000_000)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(3)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        batch_wallet_empty_after_refill_count: 0,
        batch_wallet_underfunded_event_ids: ["evt_multi_second", "evt_multi_third"],
        batch_wallet_underfunded_refill_outcomes: ["refilled", "refilled"],
        batch_wallet_underfunded_retry_count: 2,
        reservation_action: "refilled",
      })
    )
  })

  it("does not stage optimized batch refill when reservation invoice context cannot refresh", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    seedWalletReservation(db, {
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      statementKey: null,
      reservationId: "res_batch_missing_context",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 2.5 * 100_000_000,
      pendingFlushSeq: null,
      refillInFlight: false,
    })
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({ billingPeriods: [] })

    await expect(
      durableObject.applyBatch({
        customerId: baseInput.customerId,
        entitlement: baseInput.entitlement,
        enforceLimit: false,
        events: [
          {
            ...baseInput.event,
            correlationKey: "missing_context",
            id: "evt_batch_missing_context",
            idempotencyKey: "idem_batch_missing_context",
            now: BASE_NOW,
            properties: { amount: 5 },
            timestamp: BASE_NOW,
          },
        ],
        grants: baseInput.grants,
        projectId: baseInput.projectId,
      })
    ).rejects.toThrow("Missing billing period invoice context")

    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      pendingFlushSeq: null,
      refillInFlight: false,
    })
    expect(testState.captureReservationUsage).not.toHaveBeenCalled()
  })

  it("writes the same priced facts as sequential apply for representative async batches", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    testState.engineApply.mockImplementation((event: unknown, options?: PersistOptions) => {
      const index = Number(String((event as { id: string }).id).replace("evt_compare_", ""))
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: index + 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const events = Array.from({ length: 3 }, (_, index) => ({
      ...baseInput.event,
      correlationKey: `compare_${index}`,
      id: `evt_compare_${index}`,
      idempotencyKey: `idem_compare_${index}`,
      now: BASE_NOW + index,
      timestamp: BASE_NOW + index,
    }))

    const optimizedDb = createFakeDbState()
    testState.db = optimizedDb
    const optimizedObject = new EntitlementWindowDO(createDurableObjectState(), createEnv())
    await optimizedObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events,
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    const sequentialDb = createFakeDbState()
    testState.db = sequentialDb
    const sequentialObject = new EntitlementWindowDO(createDurableObjectState(), createEnv())
    for (const event of events) {
      await sequentialObject.apply({
        ...baseInput,
        event: {
          id: event.id,
          properties: event.properties,
          source: event.source,
          slug: event.slug,
          timestamp: event.timestamp,
        },
        idempotencyKey: event.idempotencyKey,
        now: event.now,
      })
    }

    const optimizedFacts = readIdempotencyMeterFacts(optimizedDb)
    const sequentialFacts = readOutboxPayloads(sequentialDb)
    expect(optimizedFacts).toEqual(sequentialFacts)
  })

  it("recovers compact async idempotency and returned facts after Durable Object eviction", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const firstState = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const batchInput = {
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "batch_1",
          id: "evt_batch_1",
          idempotencyKey: "idem_batch_1",
          now: BASE_NOW,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    }

    const firstObject = new EntitlementWindowDO(firstState, createEnv())
    await firstObject.applyBatch(batchInput)

    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(1)
    expect(testState.engineApply).toHaveBeenCalledTimes(1)

    const recoveredState = createDurableObjectState()
    const recoveredObject = new EntitlementWindowDO(recoveredState, createEnv())
    const replay = await recoveredObject.applyBatch(batchInput)

    expect(replay.results).toEqual([
      expect.objectContaining({
        allowed: true,
        correlationKey: "batch_1",
        idempotencyKey: "idem_batch_1",
      }),
    ])
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(readIdempotencyMeterFacts(db)).toHaveLength(1)
  })

  it("replays compact idempotency after eviction without fact-outbox alarm work", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    pushIdempotencyBatchRow(db, "idem_evicted_before_alarm", {
      createdAt: BASE_NOW,
      id: 1,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const baseInput = createApplyInput({
      creditLinePolicy: "uncapped",
      idempotencyKey: "idem_evicted_before_alarm",
      event: { id: "evt_evicted_before_alarm" },
    })
    const replay = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "replay",
          idempotencyKey: baseInput.idempotencyKey,
          now: BASE_NOW,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(replay.results).toEqual([
      expect.objectContaining({
        allowed: true,
        correlationKey: "replay",
        idempotencyKey: "idem_evicted_before_alarm",
      }),
    ])
    expect(testState.engineApply).not.toHaveBeenCalled()
    expect(db.idempotencyBatchRows).toHaveLength(1)
    expect(db.outboxBatchRows).toHaveLength(0)
    expect(state.alarmAt).toBeNull()
  })

  it("deduplicates repeated idempotency keys staged within the same compact batch", async () => {
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
    const baseInput = createApplyInput({ creditLinePolicy: "uncapped" })
    const result = await durableObject.applyBatch({
      customerId: baseInput.customerId,
      entitlement: baseInput.entitlement,
      enforceLimit: false,
      events: [
        {
          ...baseInput.event,
          correlationKey: "first",
          id: "evt_duplicate_first",
          idempotencyKey: "idem_duplicate_batch",
          now: BASE_NOW,
        },
        {
          ...baseInput.event,
          correlationKey: "second",
          id: "evt_duplicate_second",
          idempotencyKey: "idem_duplicate_batch",
          now: BASE_NOW + 1,
        },
      ],
      grants: baseInput.grants,
      projectId: baseInput.projectId,
    })

    expect(result.results).toEqual([
      expect.objectContaining({
        allowed: true,
        correlationKey: "first",
        idempotencyKey: "idem_duplicate_batch",
      }),
      expect.objectContaining({
        allowed: true,
        correlationKey: "second",
        idempotencyKey: "idem_duplicate_batch",
      }),
    ])
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(JSON.parse(db.idempotencyBatchRows[0]!.entries)).toHaveLength(1)
  })

  it("keeps meter facts out of the entitlement alarm and schedules lifecycle work", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter: 2 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const input = createApplyInput({
      periodEndAt: BASE_NOW + 60_000,
    })

    await durableObject.apply(input)
    await Promise.all(state.waitUntilPromises)
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)
    expect(readIdempotencyMeterFacts(db)).toEqual([
      expect.objectContaining({
        delta: 2,
        event_id: input.event.id,
        feature_slug: input.entitlement.featureSlug,
        feature_plan_version_id: "fpv_123",
        idempotency_key: input.idempotencyKey,
        value_after: 2,
        amount: 200_000_000,
        amount_after: 200_000_000,
        amount_scale: 8,
        currency: "USD",
      }),
    ])

    // Cloudflare auto-clears the scheduled alarm before invoking alarm()
    state.alarmAt = null
    await durableObject.alarm()

    expect(testState.analyticsIngest).not.toHaveBeenCalled()
    expect(state.alarmAt).toBe(BASE_NOW + 60_000)
  })

  it("cleans idempotency batches by TTL cutoff without a fact outbox drain", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    for (let index = 1; index <= 200; index++) {
      pushIdempotencyBatchRow(db, `stale_evt_${index}`, {
        createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
        id: index,
      })
    }

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    expect(testState.analyticsIngest).not.toHaveBeenCalled()
    expect(db.deleteOutboxRangeMaxIds).toEqual([])
    expect(readIdempotencyEntries(db).size).toBe(0)
    expect(db.deleteInArrayBatchSizes).toEqual([200])
  })

  it("retains idempotency batches past the ingestion age cap and cleans them at the DO TTL", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    pushIdempotencyBatchRow(db, "inside_retention_margin", {
      createdAt: BASE_NOW - TEST_INGESTION_MAX_EVENT_AGE_MS - 24 * 60 * 60 * 1000,
      id: 1,
    })
    pushIdempotencyBatchRow(db, "beyond_do_ttl", {
      createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
      id: 2,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    expect(readIdempotencyEntry(db, "inside_retention_margin")).toBeDefined()
    expect(readIdempotencyEntry(db, "beyond_do_ttl")).toBeUndefined()
  })

  it("throttles idempotency cleanup on warm alarm retries", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    pushIdempotencyBatchRow(db, "stale_first", {
      createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
      id: 1,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await durableObject.alarm()

    pushIdempotencyBatchRow(db, "stale_second", {
      createdAt: BASE_NOW - TEST_DO_IDEMPOTENCY_TTL_MS - 1,
      id: 2,
    })

    await durableObject.alarm()

    expect(readIdempotencyEntry(db, "stale_first")).toBeUndefined()
    expect(readIdempotencyEntry(db, "stale_second")).toBeDefined()
    expect(db.deleteInArrayBatchSizes).toEqual([1])
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
    expect(readOutboxPayloads(db)).toHaveLength(2)
    const fpvs = readOutboxPayloads(db).map((payload) => payload.feature_plan_version_id)
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

    expect(result).toMatchObject({ allowed: true })
    expect(readOutboxPayloads(db)).toHaveLength(2)

    const payloads = readOutboxPayloads(db)
    expect(payloads.map((payload) => payload.grant_id)).toEqual(["grant_a", "grant_b"])
    expect(payloads.map((payload) => payload.feature_plan_version_id)).toEqual([
      "fpv_entitlement",
      "fpv_entitlement",
    ])
    expect(payloads.map((payload) => payload.delta)).toEqual([3, 2])
    expect(payloads.map((payload) => payload.amount)).toEqual([300_000_000, 200_000_000])
    expect(payloads.map((payload) => payload.amount_after)).toEqual([300_000_000, 200_000_000])

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

    const payloads = readOutboxPayloads(db)
    expect(payloads.map((payload) => payload.feature_plan_version_id)).toEqual([
      "fpv_original",
      "fpv_original",
    ])
    expect(payloads.map((payload) => payload.feature_slug)).toEqual(["api_calls", "api_calls"])
  })

  it("getStatus returns operational metadata without mutating state", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    testState.db = createFakeDbState()

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.getStatus()

    expect(result).toEqual({
      durableObjectId: state.id.toString(),
      outboxCount: 0,
      nextAlarmAt: null,
      lastIdempotencyCleanupAt: null,
      walletReservation: null,
    })
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

    expect(result).toEqual({
      usage: 0,
      limit: null,
      isLimitReached: false,
      spending: {
        currency: "USD",
        ledgerAmount: 0,
        scale: 8,
      },
    })
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
      spending: {
        currency: "USD",
        ledgerAmount: 700_000_000,
        scale: 8,
      },
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
      spending: {
        currency: "USD",
        ledgerAmount: 700_000_000,
        scale: 8,
      },
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
      spending: {
        currency: "USD",
        ledgerAmount: 300_000_000,
        scale: 8,
      },
    })
  })

  it("caches enforcement state between verify calls and refreshes after apply commits", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    const durableObject = new EntitlementWindowDO(state, createEnv())

    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 4, meterKey: DEFAULT_METER_KEY, valueAfter: 4 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(createApplyInput({ limit: 10 }))

    db.storageReadCounts.entitlementConfig = 0
    db.storageReadCounts.grants = 0
    db.storageReadCounts.grantWindows = 0

    expect(await durableObject.getEnforcementState()).toMatchObject({
      usage: 4,
      limit: 10,
      isLimitReached: false,
    })
    const readsAfterFirstVerify = { ...db.storageReadCounts }

    expect(await durableObject.getEnforcementState()).toMatchObject({
      usage: 4,
      limit: 10,
      isLimitReached: false,
    })
    expect(db.storageReadCounts).toEqual(readsAfterFirstVerify)

    testState.engineApply.mockImplementationOnce((_event, options?: PersistOptions) => {
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter: 6 }]
      options?.beforePersist?.(facts)
      return facts
    })
    await durableObject.apply(
      createApplyInput({
        idempotencyKey: "idem_cache_refresh",
        event: { id: "evt_cache_refresh" },
        limit: 10,
      })
    )

    const readsAfterApply = { ...db.storageReadCounts }
    expect(await durableObject.getEnforcementState()).toMatchObject({
      usage: 6,
      limit: 10,
      isLimitReached: false,
    })
    expect(db.storageReadCounts.grantWindows).toBeGreaterThan(readsAfterApply.grantWindows)
  })

  it("leaves an active reservation open when enforcement state reaches the limit", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    db.grantWindowRows.set("grant_123:onetime:1773921540000", {
      bucketKey: "grant_123:onetime:1773921540000",
      grantId: "grant_123",
      periodKey: "onetime:1773921540000",
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 10,
      exhaustedAt: null,
    })
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      reservationEndAt: BASE_NOW + 60_000,
      usage: 10,
      updatedAt: BASE_NOW,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_verify_limit",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 10 * 100_000_000,
      flushedAmount: 8 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 100_000_000,
      refillInFlight: false,
      flushSeq: 4,
      pendingFlushSeq: null,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 30_000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const applyInput = createApplyInput({ limit: 10 })
    const result = await durableObject.getEnforcementState({
      entitlement: applyInput.entitlement,
      grants: applyInput.grants,
      now: BASE_NOW,
    })

    expect(result).toMatchObject({ usage: 10, limit: 10, isLimitReached: true })
    expect(state.waitUntilPromises).toHaveLength(0)
    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBe("res_verify_limit")
  })

  it("does not schedule verify-path final flush when a wallet flush is already pending", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    db.grantWindowRows.set("grant_123:onetime:1773921540000", {
      bucketKey: "grant_123:onetime:1773921540000",
      grantId: "grant_123",
      periodKey: "onetime:1773921540000",
      periodStartAt: BASE_NOW - 60_000,
      periodEndAt: BASE_NOW + 60_000,
      consumedInCurrentWindow: 10,
      exhaustedAt: null,
    })
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      reservationEndAt: BASE_NOW + 60_000,
      usage: 10,
      updatedAt: BASE_NOW,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_verify_pending",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 10 * 100_000_000,
      flushedAmount: 8 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 100_000_000,
      refillInFlight: true,
      flushSeq: 4,
      pendingFlushSeq: 4,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 30_000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const applyInput = createApplyInput({ limit: 10 })
    const result = await durableObject.getEnforcementState({
      entitlement: applyInput.entitlement,
      grants: applyInput.grants,
      now: BASE_NOW,
    })

    expect(result).toMatchObject({ usage: 10, limit: 10, isLimitReached: true })
    expect(state.waitUntilPromises).toHaveLength(0)
    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      reservationId: "res_verify_pending",
      refillInFlight: true,
      pendingFlushSeq: 4,
      flushSeq: 4,
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
    expect(result).toEqual({
      usage: 0,
      limit: 10,
      isLimitReached: false,
      spending: {
        currency: "USD",
        ledgerAmount: 0,
        scale: 8,
      },
    })
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
    await Promise.all(state.waitUntilPromises)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationEndAt).toBe(
      input.grants[0]!.expiresAt
    )

    // Simulate eviction: the persisted alarm remains while the DO instance is replaced.
    const revived = new EntitlementWindowDO(state, createEnv())
    await revived.getStatus()
    expect(state.alarmAt).toBe(BASE_NOW + 30_000)

    // Simulate the constructor-recovered flush alarm firing.
    state.alarmAt = null
    await revived.alarm()

    // The revived DO sees a still-open reservation in SQLite and re-arms
    // alarm() at the next lifecycle deadline after the outbox and reservation
    // usage are flushed.
    expect(state.alarmAt).toBe(BASE_NOW + 60_000)
  })

  it("replays committed idempotency rows after eviction without applying twice", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })

    const input = createApplyInput()
    const first = new EntitlementWindowDO(state, createEnv())
    await expect(first.apply(input)).resolves.toMatchObject({ allowed: true })

    const revived = new EntitlementWindowDO(state, createEnv())
    await expect(revived.apply(input)).resolves.toMatchObject({ allowed: true })

    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(readIdempotencyEntries(db).size).toBe(1)
    expect(readOutboxPayloads(db)).toHaveLength(1)
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
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({ allowed: true })
    // Bootstrap fired with the period window from the input.
    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(testState.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_123",
        customerId: "cus_123",
        currency: "USD",
        entitlementId: "ce_123",
        metadata: expect.objectContaining({
          requestedBy: "durable_object",
          requestedById: "do_123",
          durableObjectId: "do_123",
          customerEntitlementId: "ce_123",
          featureSlug: "api_calls",
          eventSlug: "tokens_used",
          meterKey: DEFAULT_METER_KEY,
        }),
      })
    )
    // The reservation is persisted onto the window so subsequent events use
    // the in-tx reservation policy check directly.
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.reservationId).toBe("res_lazy")
    expect(row?.allocationAmount).toBe(5 * 100_000_000)
  })

  it("does not request a $1 bootstrap reservation for micro-priced meters", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: { totalPrice: { dinero: fakeDinero(Math.max(0, quantity) * 2, 8) } },
    }))
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_micro",
        allocationAmount: 150,
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({ allowed: true })
    expect(testState.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAmount: 150 })
    )

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)
    expect(row?.allocationAmount).toBe(150)
    expect(row?.consumedAmount).toBe(6)
    expect(row?.targetReservationAmount).toBeLessThan(100_000_000)
    expect(row?.spendEwmaAmount).toBe(0)
    expect(row?.lastRateSampledAtMs).toBe(BASE_NOW)
    expect(row?.maxEventCostAmount).toBe(6)
  })

  it("sizes a high-price single-event bootstrap from the current event cost", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.pricePerFeature.mockImplementation(({ quantity }: { quantity: number }) => ({
      val: { totalPrice: { dinero: fakeDinero(Math.max(0, quantity) * 500, 2) } },
    }))
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.createReservation.mockResolvedValue({
      err: null,
      val: {
        reservationId: "res_high_price",
        allocationAmount: 5 * 100_000_000,
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({ event: { ...createApplyInput().event, properties: { amount: 1 } } })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(testState.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAmount: 5 * 100_000_000 })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(5 * 100_000_000)
  })

  it("replays lazy reservation bootstrap after eviction before local reservation commit", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.createReservation
      .mockResolvedValueOnce({
        err: null,
        val: {
          reservationId: "res_lazy",
          allocationAmount: 5 * 100_000_000,
        },
      })
      .mockResolvedValueOnce({
        err: null,
        val: {
          reservationId: "res_lazy",
          allocationAmount: 5 * 100_000_000,
          reused: "active",
        },
      })
    db.failNextMeterWindowUpdate = {
      matchKey: "reservationId",
      error: new Error("evicted after createReservation"),
    }

    const input = createApplyInput()
    const first = new EntitlementWindowDO(state, createEnv())
    await expect(first.apply(input)).rejects.toThrow("evicted after createReservation")

    expect(testState.createReservation).toHaveBeenCalledTimes(1)
    expect(readIdempotencyEntries(db).size).toBe(0)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()

    const revived = new EntitlementWindowDO(state, createEnv())
    await expect(revived.apply(input)).resolves.toMatchObject({ allowed: true })

    expect(testState.createReservation).toHaveBeenCalledTimes(2)
    const expectedIdempotencyKey = `do_lazy:ce_123:onetime:${BASE_NOW - 60_000}`
    expect(testState.createReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: expectedIdempotencyKey })
    )
    expect(testState.createReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: expectedIdempotencyKey })
    )
    expect(testState.engineApply).toHaveBeenCalledTimes(1)
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({ allowed: true })
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBe("res_lazy")
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
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(testState.logger.error).not.toHaveBeenCalled()
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply",
      expect.objectContaining({
        denied_reason: "WALLET_EMPTY",
        deny_message: "Wallet has no available balance to back the reservation",
      })
    )
    const applyLogPayload = testState.logger.info.mock.calls.find(
      ([message]) => message === "entitlement apply"
    )?.[1] as Record<string, unknown> | undefined
    expect(applyLogPayload).toBeDefined()
    if (!applyLogPayload) throw new Error("missing entitlement apply log payload")
    expect(applyLogPayload).not.toHaveProperty("error")
    expect(applyLogPayload).not.toHaveProperty("error_type")
    expect(applyLogPayload).not.toHaveProperty("error_message")
    expect(Object.prototype.hasOwnProperty.call(applyLogPayload, "error.message")).toBe(false)
  })

  it("throws lazy bootstrap wallet errors without caching a WALLET_EMPTY denial", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    const walletError = new Error("WALLET_LEDGER_FAILED")
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.createReservation.mockResolvedValue({
      err: walletError,
      val: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())

    await expect(durableObject.apply(createApplyInput())).rejects.toThrow("WALLET_LEDGER_FAILED")
    expect(readIdempotencyEntries(db).has("idem_123")).toBe(false)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(testState.logger.error).toHaveBeenCalledWith(
      walletError,
      expect.objectContaining({
        context: "lazy reservation bootstrap failed",
        customer_id: "cus_123",
        project_id: "proj_123",
        customer_entitlement_id: "ce_123",
      })
    )
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement apply",
      expect.objectContaining({
        bootstrap_attempted: true,
        bootstrap_outcome: "error",
        outcome: "error",
        error_message: "WALLET_LEDGER_FAILED",
      })
    )
    expect(testState.logger.info).not.toHaveBeenCalledWith(
      "entitlement apply",
      expect.objectContaining({
        outcome: "denied",
        denied_reason: "WALLET_EMPTY",
      })
    )
  })

  it("fails before wallet reservation side effects when invoice context is missing", async () => {
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

    await expect(durableObject.apply(createApplyInput({ billingPeriods: [] }))).rejects.toThrow(
      "Missing billing period invoice context"
    )
    expect(testState.createReservation).not.toHaveBeenCalled()
    expect(readIdempotencyEntries(db).has("idem_123")).toBe(false)
    expect(readOutboxPayloads(db)).toHaveLength(0)
  })

  it("denies when a partial bootstrap grant cannot cover the current event", async () => {
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
        reservationId: "res_partial_bootstrap",
        allocationAmount: 100_000_000,
      },
    })
    testState.flushReservation.mockImplementation(
      async (input: { final: boolean; flushAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: 0,
          flushedAmount: input.flushAmount,
          refundedAmount: input.final ? 100_000_000 : 0,
        },
      })
    )

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(testState.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAmount: 3 * 100_000_000 })
    )
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reservationId: "res_partial_bootstrap",
        flushAmount: 0,
        refillChunkAmount: 5 * 100_000_000,
        final: false,
      })
    )

    await Promise.all(state.waitUntilPromises)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reservationId: "res_partial_bootstrap",
        refillChunkAmount: 0,
        final: true,
      })
    )
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()
  })

  it("allows uncapped priced usage without opening a wallet reservation", async () => {
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
        reservationId: "res_empty",
        allocationAmount: 0,
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput({ creditLinePolicy: "uncapped" }))

    expect(result).toMatchObject({ allowed: true })
    expect(testState.createReservation).not.toHaveBeenCalled()
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeUndefined()
  })

  it("grows the reservation and allows the event when local allocation is short", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockImplementation(
      async (input: { flushAmount: number; refillChunkAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: input.refillChunkAmount,
          flushedAmount: input.flushAmount,
          refundedAmount: 0,
        },
      })
    )

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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 0,
      refillChunkAmount: 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({ allowed: true })
    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 1,
        flushAmount: 2 * 100_000_000,
        refillChunkAmount: 8 * 100_000_000,
        final: false,
      })
    )
    expect(testState.engineApply).toHaveBeenCalledTimes(2)
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(readIdempotencyEntry(db, "idem_123")).toMatchObject({ allowed: true })
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.allocationAmount).toBe(10 * 100_000_000)
    expect(row.consumedAmount).toBe(5 * 100_000_000)
    expect(row.flushedAmount).toBe(2 * 100_000_000)
    expect(row.flushSeq).toBe(1)
    expect(row.pendingFlushSeq).toBeNull()
    expect(row.refillInFlight).toBe(false)
  })

  it("denies with WALLET_EMPTY and closes the reservation when a synchronous refill cannot fund the event", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 3, meterKey: DEFAULT_METER_KEY, valueAfter: 3 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockImplementation(
      async (input: { final: boolean; flushAmount: number; refillChunkAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: 0,
          flushedAmount: input.flushAmount,
          refundedAmount: input.final ? 10 : 0,
        },
      })
    )

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
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
      message: "Wallet empty for meter tokens_used (reservation res_abc)",
    })
    // The first attempt rolls back, does one sync refill attempt, retries,
    // persists the denial, then schedules a final flush. Replay returns the
    // stored denial without touching the wallet again.
    expect(second).toEqual(first)
    expect(testState.engineApply).toHaveBeenCalledTimes(2)
    expect(testState.flushReservation).toHaveBeenCalledTimes(2)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 1,
        flushAmount: 2 * 100_000_000 - 10,
        refillChunkAmount: 8 * 100_000_000 - 20,
        final: false,
      })
    )
    await Promise.all(state.waitUntilPromises)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 2,
        flushAmount: 0,
        refillChunkAmount: 0,
        final: true,
      })
    )
    expect(readIdempotencyEntries(db).size).toBe(1)
    expect(readOutboxPayloads(db)).toHaveLength(0)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(2 * 100_000_000 - 10)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.flushSeq).toBe(2)
    expect(state.waitUntilPromises).toHaveLength(2)
  })

  it("caps synchronous grow when the current event is larger than max outstanding", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 32, meterKey: DEFAULT_METER_KEY, valueAfter: 32 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockImplementation(
      async (input: { final: boolean; flushAmount: number; refillChunkAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: input.final ? 0 : input.refillChunkAmount,
          flushedAmount: input.flushAmount,
          refundedAmount: input.final ? input.refillChunkAmount : 0,
        },
      })
    )

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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_large_event",
      allocationAmount: 0,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 0,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: BASE_NOW,
      maxEventCostAmount: 0,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({ event: { ...createApplyInput().event, properties: { amount: 32 } } })
    )

    expect(result).toMatchObject({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
    })
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reservationId: "res_large_event",
        flushAmount: 0,
        refillChunkAmount: 30 * 100_000_000,
        final: false,
      })
    )

    await Promise.all(state.waitUntilPromises)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reservationId: "res_large_event",
        flushAmount: 0,
        refillChunkAmount: 0,
        final: true,
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.reservationId).toBeNull()
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // 5 events @ $1.00 = $5.00 at LEDGER_SCALE=8.
    expect(row.consumedAmount).toBe(5 * 100_000_000)
    // Refill was scheduled via ctx.waitUntil; the stub body settles
    // synchronously on the microtask queue, so by the time this assertion runs
    // the single-flight flag has already cleared.
    expect(state.waitUntilPromises).toHaveLength(2)

    await Promise.all(state.waitUntilPromises)
    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(after.refillInFlight).toBe(false)
    expect(after.pendingFlushSeq).toBeNull()
  })

  it("does not persist refill pending state when reservation invoice context is missing", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
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
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      statementKey: null,
      reservationId: "res_missing_context",
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
    await expect(durableObject.apply(createApplyInput({ billingPeriods: [] }))).rejects.toThrow(
      "Missing billing period invoice context"
    )

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.pendingFlushSeq).toBeNull()
    expect(row.refillInFlight).toBe(false)
    expect(testState.captureReservationUsage).not.toHaveBeenCalled()
  })

  it("refreshes missing invoice context on an active reservation before wallet spend", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
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
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      statementKey: null,
      reservationId: "res_legacy_context",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 0,
      refillChunkAmount: 0,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(createApplyInput())

    expect(result).toMatchObject({ allowed: true })
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
    })
  })

  it("adapts the refill target upward after a sudden fast burn", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 2, meterKey: DEFAULT_METER_KEY, valueAfter: 2 }]
      options?.beforePersist?.(facts)
      return facts
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_fast_burn",
      allocationAmount: 2 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 2 * 100_000_000,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: BASE_NOW - 1_000,
      maxEventCostAmount: 0,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({ event: { ...createApplyInput().event, properties: { amount: 2 } } })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(state.waitUntilPromises).toHaveLength(2)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_fast_burn",
        flushSeq: 1,
        flushAmount: 2 * 100_000_000,
        refillChunkAmount: 30 * 100_000_000,
        final: false,
      })
    )

    await Promise.all(state.waitUntilPromises)
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.spendEwmaAmount).toBe(1200 * 100_000_000)
    expect(row.targetReservationAmount).toBe(30 * 100_000_000)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })
    // consumedAmount still advances; only the refill trigger is suppressed.
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.consumedAmount).toBe(2 * 100_000_000)
    expect(state.waitUntilPromises).toHaveLength(1)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.pendingFlushSeq).toBe(4)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)?.flushSeq).toBe(4)
  })

  it("clamps negative corrections so consumed never falls below flushed", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: -5, meterKey: DEFAULT_METER_KEY, valueAfter: 5 }]
      options?.beforePersist?.(facts)
      return facts
    })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 10,
      updatedAt: BASE_NOW - 1_000,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_negative_correction",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 10 * 100_000_000,
      flushedAmount: 8 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 10 * 100_000_000,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: BASE_NOW,
      maxEventCostAmount: 0,
      refillInFlight: false,
      flushSeq: 2,
      pendingFlushSeq: null,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({ event: { ...createApplyInput().event, properties: { amount: -5 } } })
    )

    expect(result).toMatchObject({ allowed: true })
    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.consumedAmount).toBe(8 * 100_000_000)
    expect(row.consumedAmount).toBeGreaterThanOrEqual(row.flushedAmount ?? 0)
    expect(state.waitUntilPromises).toHaveLength(1)

    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(-5 * 100_000_000)
  })

  // ---------------------------------------------------------------------
  // In-process flush+refill. These exercise the real requestFlushAndRefill
  // path: the DO calls wallet capture/extend/release commands
  // (mocked), then folds the returned allocation/flush deltas back into
  // SQLite. We assert both the happy path (grantedAmount extends runway,
  // flushSeq advances, pendingFlushSeq clears) and the failure modes
  // (error result + thrown error both clear refillInFlight but preserve
  // pendingFlushSeq so crash recovery / the next apply can retry).
  // ---------------------------------------------------------------------

  it("folds wallet reservation command results into SQLite on a successful flush+refill", async () => {
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    expect(result).toMatchObject({ allowed: true })
    await Promise.all(state.waitUntilPromises)

    // Contract with WalletService: capture uses the canonical invoice
    // context persisted on the wallet reservation snapshot.
    expect(testState.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        billingPeriodId: "bp_123",
        kind: "usage",
        reservationId: "res_abc",
        statementKey: "stmt_123",
        sourceId: "bp_123:item_123",
        metadata: expect.objectContaining({
          billing_period_id: "bp_123",
          cycle_end_at: BASE_NOW + 60_000,
          cycle_start_at: BASE_NOW - 60_000,
          durable_object_id: "do_123",
          feature_plan_version_item_id: "item_123",
          flush_seq: 8,
          reservation_id: "res_abc",
          source_id: "bp_123:item_123",
        }),
      })
    )
    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith({
      projectId: "proj_123",
      customerId: "cus_123",
      currency: "USD",
      reservationId: "res_abc",
      flushSeq: 8,
      flushAmount: 5 * 100_000_000,
      refillChunkAmount: 10 * 100_000_000,
      effectiveAt: new Date(BASE_NOW),
      statementKey: "stmt_123",
      final: false,
      metadata: expect.objectContaining({
        billing_period_id: "bp_123",
        cycle_end_at: BASE_NOW + 60_000,
        cycle_start_at: BASE_NOW - 60_000,
        feature_plan_version_item_id: "item_123",
        flush_seq: 8,
        reservation_id: "res_abc",
        requestedBy: "durable_object",
        requestedById: "do_123",
        durableObjectId: "do_123",
        durable_object_id: "do_123",
        source_id: "bp_123:item_123",
      }),
      sourceId: "bp_123:item_123",
    })

    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    // Allocation extended by grantedAmount; flushed catches up to consumed.
    expect(after.allocationAmount).toBe(9 * 100_000_000)
    expect(after.flushedAmount).toBe(5 * 100_000_000)
    expect(after.flushSeq).toBe(8)
    expect(after.pendingFlushSeq).toBeNull()
    expect(after.refillInFlight).toBe(false)
    expect(testState.logger.info).toHaveBeenCalledWith(
      "entitlement flush_refill",
      expect.objectContaining({
        reservation_refill_requested_amount: 10 * 100_000_000,
        reservation_refill_granted_amount: 4 * 100_000_000,
        reservation_refill_partial: true,
      })
    )
  })

  it("clears refillInFlight but preserves pendingFlushSeq when wallet commands return an error", async () => {
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    expect(after.pendingFlushAmount).toBe(5 * 100_000_000)
    expect(after.refillInFlight).toBe(false)
  })

  it("clears refillInFlight when wallet commands throw unexpectedly", async () => {
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    expect(after.pendingFlushAmount).toBe(5 * 100_000_000)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 3 * 100_000_000,
      consumedAmount: 100_000_000,
      flushedAmount: 0,
      consumedQuantity: 1,
      flushedQuantity: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 2 * 100_000_000,
      refillInFlight: false,
      flushSeq: 4,
      pendingFlushSeq: 5,
      pendingFlushAmount: 100_000_000,
      pendingFlushQuantity: 1,
      pendingRefillAmount: 2 * 100_000_000,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    // The recovery check runs inside blockConcurrencyWhile (the DO's
    // `ready` promise). Drive that to completion through a public method
    // that awaits `ready` before we inspect the scheduled waitUntils.
    await durableObject.getEnforcementState()
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    // Retry replays the SAME seq (5), not a new one, with the persisted
    // pending flush amount.
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
    expect(after.pendingFlushAmount).toBeNull()
    expect(after.pendingRefillAmount).toBe(0)
    expect(after.allocationAmount).toBe(5 * 100_000_000)
    expect(after.flushedAmount).toBe(100_000_000)
    // Lazy Neon connection was opened once for the flush call.
    expect(durableObject).toBeDefined()
  })

  it("reuses persisted pending flush and refill amounts when a new event grows the same pending seq", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.engineApply.mockImplementation((_event: unknown, options?: PersistOptions) => {
      const facts = [{ delta: 1, meterKey: DEFAULT_METER_KEY, valueAfter: 1 }]
      options?.beforePersist?.(facts)
      return facts
    })
    testState.flushReservation.mockImplementation(
      async (input: { flushAmount: number; refillChunkAmount: number }) => ({
        err: null,
        val: {
          grantedAmount: input.refillChunkAmount,
          flushedAmount: input.flushAmount,
          refundedAmount: 0,
        },
      })
    )

    const durableObject = new EntitlementWindowDO(state, createEnv())

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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_pending_refill",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 10 * 100_000_000,
      spendEwmaAmount: 123,
      lastRateSampledAtMs: BASE_NOW - 60_000,
      maxEventCostAmount: 0,
      pendingFlushAmount: 5 * 100_000_000,
      pendingRefillAmount: 2 * 100_000_000,
      refillInFlight: false,
      flushSeq: 7,
      pendingFlushSeq: 8,
      pendingFlushFinal: false,
      recoveryRequired: true,
    })

    const result = await durableObject.apply(
      createApplyInput({ event: { ...createApplyInput().event, properties: { amount: 1 } } })
    )
    await Promise.all(state.waitUntilPromises)

    expect(result).toMatchObject({ allowed: true })
    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_pending_refill",
        flushSeq: 8,
        flushAmount: 5 * 100_000_000,
        refillChunkAmount: 2 * 100_000_000,
        final: false,
      })
    )

    const after = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(after.allocationAmount).toBe(12 * 100_000_000)
    expect(after.consumedAmount).toBe(6 * 100_000_000)
    expect(after.flushedAmount).toBe(5 * 100_000_000)
    expect(after.flushSeq).toBe(8)
    expect(after.pendingFlushSeq).toBeNull()
    expect(after.pendingFlushAmount).toBeNull()
    expect(after.pendingRefillAmount).toBe(0)
    expect(after.spendEwmaAmount).toBe(123)
  })

  it("replays wallet flush with the same seq after eviction loses the local fold", async () => {
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
      err: null,
      val: {
        grantedAmount: 4 * 100_000_000,
        flushedAmount: 5 * 100_000_000,
        refundedAmount: 0,
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    db.failNextMeterWindowUpdate = {
      matchKey: "lastFlushedAt",
      error: new Error("evicted after wallet commit"),
    }

    const first = new EntitlementWindowDO(state, createEnv())
    await expect(first.apply(createApplyInput())).resolves.toMatchObject({ allowed: true })
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 0,
      flushSeq: 7,
      pendingFlushSeq: 8,
      pendingFlushAmount: 5 * 100_000_000,
      pendingRefillAmount: 10 * 100_000_000,
      refillInFlight: false,
    })

    const revived = new EntitlementWindowDO(state, createEnv())
    await revived.getEnforcementState()
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledTimes(2)
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 8,
        flushAmount: 5 * 100_000_000,
        refillChunkAmount: 10 * 100_000_000,
      })
    )
    expect(testState.flushReservation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 8,
        flushAmount: 5 * 100_000_000,
        refillChunkAmount: 10 * 100_000_000,
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      allocationAmount: 9 * 100_000_000,
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 5 * 100_000_000,
      flushSeq: 8,
      pendingFlushSeq: null,
      pendingFlushAmount: null,
      pendingRefillAmount: 0,
      refillInFlight: false,
    })
  })

  it("recovers a pending final flush that already reconciled in the wallet", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.flushReservation.mockResolvedValue({
      err: { message: "WALLET_RESERVATION_ALREADY_RECONCILED" },
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      consumedQuantity: 2,
      flushedQuantity: 0,
      refillThresholdBps: 5000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: true,
      flushSeq: 3,
      pendingFlushSeq: 4,
      pendingFlushAmount: 2 * 100_000_000,
      pendingFlushQuantity: 2,
      pendingFlushFinal: true,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.getEnforcementState()
    await Promise.all(state.waitUntilPromises)

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_abc",
        flushSeq: 4,
        flushAmount: 2 * 100_000_000,
        refillChunkAmount: 0,
        final: true,
      })
    )

    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      reservationId: null,
      flushedAmount: 2 * 100_000_000,
      flushSeq: 4,
      pendingFlushSeq: null,
      pendingFlushAmount: null,
      pendingFlushFinal: false,
      refillInFlight: false,
      recoveryRequired: false,
    })
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    // Identity fields are what wallet commands need to call the ledger
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 3,
      pendingFlushSeq: null,
      pendingFlushFinal: false,
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
        statementKey: "stmt_123",
        sourceId: "bp_123:item_123",
        metadata: expect.objectContaining({
          billing_period_id: "bp_123",
          cycle_end_at: BASE_NOW + 60_000,
          cycle_start_at: BASE_NOW - 60_000,
          feature_plan_version_item_id: "item_123",
          flush_seq: 4,
          reservation_id: "res_abc",
          source_id: "bp_123:item_123",
        }),
      })
    )

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.reservationId).toBeNull()
    expect(row.flushedAmount).toBe(2 * 100_000_000)
    expect(row.flushSeq).toBe(4)
    expect(row.pendingFlushSeq).toBeNull()
    expect(state.deletedAll).toBe(false)
  })

  it("does not persist final pending state when reservation invoice context is missing", async () => {
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
      billingPeriodId: null,
      cycleEndAt: null,
      cycleStartAt: null,
      featurePlanVersionItemId: null,
      statementKey: null,
      reservationId: "res_missing_context",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 3,
      pendingFlushSeq: null,
      pendingFlushFinal: false,
      lastEventAt: periodEndAt - 1000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.pendingFlushSeq).toBeNull()
    expect(row.pendingFlushFinal).toBe(false)
    expect(row.recoveryRequired).toBe(true)
    expect(testState.captureReservationUsage).not.toHaveBeenCalled()
  })

  it("alarm runs a final flush when the DO has been inactive for more than 1h", async () => {
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
      },
    })

    const now = Date.now()
    // Inactivity > 1h; period hasn't ended yet.
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 2 * 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 2 * 60 * 60 * 1000,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 61 * 60 * 1000,
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

  it("alarm runs a final flush after 60s of inactivity in development", async () => {
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
      createdAt: now - 5 * 60_000,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_dev",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 60_000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv({ NODE_ENV: "development" }))
    await durableObject.alarm()

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({ final: true, flushAmount: 0, reservationId: "res_dev" })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)!.reservationId).toBeNull()
  })

  it("alarm keeps a live reservation open before the 1h inactivity threshold", async () => {
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_abc",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 59 * 60 * 1000,
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

  it("does not re-arm every second when a live reservation is already fully flushed", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.analyticsIngest.mockResolvedValue({ quarantined_rows: 0, successful_rows: 0 })

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 2 * 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: BASE_NOW - 24 * 60 * 60 * 1000,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_fully_flushed",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 2 * 100_000_000,
      flushedAmount: 2 * 100_000_000,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 2,
      pendingFlushSeq: null,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 10 * 60_000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(state.alarmAt).toBe(BASE_NOW + 60 * 60 * 1000)
  })

  it("time-based wallet flush captures usage without requesting a zero-amount refill", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    seedWalletReservation(db, {
      reservationId: "res_time_flush",
      reservationEndAt: BASE_NOW + 2 * 60 * 60 * 1000,
      periodEndAt: BASE_NOW + 2 * 60 * 60 * 1000,
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 595_600_000,
      flushedAmount: 0,
      consumedQuantity: 12,
      flushedQuantity: 0,
      flushSeq: 2,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 10 * 60_000,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(testState.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 595_600_000,
        billingPeriodId: "bp_123",
        flushSeq: 3,
        kind: "usage",
        reservationId: "res_time_flush",
        statementKey: "stmt_123",
      })
    )
    expect(testState.flushReservation).not.toHaveBeenCalled()

    const row = db.meterWindowRows.get(DEFAULT_METER_KEY)!
    expect(row.allocationAmount).toBe(10 * 100_000_000)
    expect(row.flushedAmount).toBe(595_600_000)
    expect(row.flushedQuantity).toBe(12)
    expect(row.flushSeq).toBe(3)
    expect(row.pendingFlushSeq).toBeNull()
    expect(row.pendingFlushAmount).toBeNull()
    expect(row.pendingRefillAmount).toBe(0)
    expect(row.refillInFlight).toBe(false)
    expect(state.alarmAt).toBe(BASE_NOW + 60 * 60 * 1000)
  })

  it("alarm runs a final flush after 1h of inactivity in deployed environments", async () => {
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
      },
    })

    const now = Date.now()
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: now + 2 * 60 * 60 * 1000,
      usage: 0,
      updatedAt: null,
      createdAt: now - 2 * 60 * 60 * 1000,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_prod_inactive",
      allocationAmount: 5 * 100_000_000,
      consumedAmount: 0,
      flushedAmount: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 4 * 100_000_000,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      lastEventAt: now - 60 * 60 * 1000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    await durableObject.alarm()

    expect(testState.flushReservation).toHaveBeenCalledTimes(1)
    expect(testState.flushReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        final: true,
        flushAmount: 0,
        reservationId: "res_prod_inactive",
      })
    )
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)!.reservationId).toBeNull()
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

  it("deletion cleanup no longer waits on entitlement-local fact outbox rows", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db
    testState.flushReservation.mockResolvedValue({
      err: null,
      val: {
        grantedAmount: 0,
        flushedAmount: 1 * 100_000_000,
        refundedAmount: 4 * 100_000_000,
      },
    })

    const now = Date.now()
    pushOutboxBatchRow(db, 1, now)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    expect(readOutboxPayloads(db)).toHaveLength(1)
    expect(state.deletedAlarm).toBe(true)
    expect(state.deletedAll).toBe(true)
    expect(testState.analyticsIngest).not.toHaveBeenCalled()
    expect(testState.logger.warn).not.toHaveBeenCalledWith(
      "entitlement deletion cleanup failed",
      expect.anything()
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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
    expect(row.pendingFlushAmount).toBe(2 * 100_000_000)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })

    // €1.031 = 1 × 10^8 + 31 × 10^5 = 103_100_000 minor units at LEDGER_SCALE=8.
    // This is what proves the flat fee is captured: a unit-price-only
    // calculation would emit only 31 × 10^5 = 3_100_000.
    expect(readOutboxPayloads(db)).toHaveLength(1)
    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(103_100_000)
    expect(payload.amount_after).toBe(103_100_000)
    expect(payload.amount_scale).toBe(8)
    expect(payload.currency).toBe("EUR")
    expect(payload.value_after).toBe(31)
    expect(payload.delta).toBe(1)

    // The wallet policy deducts the full €1.031 from the allocation,
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })

    // €0.001 = 100_000 minor units at scale-8. The flat fee is NOT charged
    // again — it accrued once at the 30→31 boundary. The diff approach
    // (price(after) − price(before)) is what makes this correct.
    expect(readOutboxPayloads(db)).toHaveLength(1)
    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(100_000)
    expect(payload.amount_after).toBe(103_200_000)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })

    // €1.05 = 50 × €0.001 + €1 flat = 1_050_000 × 100 = 105_000_000 minor
    // units at scale-8.
    expect(readOutboxPayloads(db)).toHaveLength(1)
    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(105_000_000)
    expect(payload.amount_after).toBe(105_000_000)
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
      },
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.apply(
      createApplyInput({
        priceConfig: VOLUME_FLAT_TIER_PRICE_CONFIG,
        currency: "EUR",
      })
    )

    expect(result).toMatchObject({ allowed: true })
    expect(testState.createReservation).not.toHaveBeenCalled()

    expect(readOutboxPayloads(db)).toHaveLength(1)
    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(0)
    expect(payload.amount_after).toBe(0)
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
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
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

    expect(result).toMatchObject({ allowed: true })
    expect(testState.createReservation).toHaveBeenCalledTimes(1)

    const call = testState.createReservation.mock.calls[0]?.[0] as { requestedAmount: number }
    expect(call.requestedAmount).toBe(103_100_000)

    expect(readOutboxPayloads(db)).toHaveLength(1)
    const payload = readOutboxPayloads(db)[0]!
    expect(payload.amount).toBe(103_100_000)
    expect(payload.amount_after).toBe(103_100_000)
    expect(payload.value_after).toBe(31)
    expect(payload.tier_index).toBe(7)
    expect(payload.tier_mode).toBe("graduated")
    expect(payload.pricing_component_count).toBe(9)
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

  it("flushes a matching reservation for invoicing without closing it", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      reservationEndAt: BASE_NOW + 60_000,
      usage: 6,
      updatedAt: BASE_NOW,
      createdAt: BASE_NOW,
      projectId: "proj_123",
      customerId: "cus_123",
      billingPeriodId: "bp_123",
      cycleEndAt: BASE_NOW + 60_000,
      cycleStartAt: BASE_NOW - 60_000,
      featurePlanVersionItemId: "item_123",
      featureSlug: "api_calls",
      statementKey: "stmt_123",
      reservationId: "res_invoice",
      allocationAmount: 10 * 100_000_000,
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 2 * 100_000_000,
      consumedQuantity: 5,
      flushedQuantity: 2,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 10 * 100_000_000,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: null,
      maxEventCostAmount: 100_000_000,
      pendingRefillAmount: 0,
      pendingFlushAmount: null,
      pendingFlushQuantity: null,
      refillInFlight: false,
      flushSeq: 2,
      pendingFlushSeq: null,
      pendingFlushFinal: false,
      lastEventAt: BASE_NOW,
      lastFlushedAt: BASE_NOW - 30_000,
      deletionRequested: false,
      recoveryRequired: false,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.flushReservationForInvoicing({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result).toMatchObject({ ok: true, outcome: "flushed" })
    expect(testState.captureReservationUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "res_invoice",
        flushSeq: 3,
        amount: 3 * 100_000_000,
        kind: "usage",
        statementKey: "stmt_123",
      })
    )
    // refillAmount: 0 means no extension is requested
    expect(testState.flushReservation).not.toHaveBeenCalled()
    expect(db.meterWindowRows.get(DEFAULT_METER_KEY)).toMatchObject({
      reservationId: "res_invoice",
      flushedAmount: 5 * 100_000_000,
      pendingFlushFinal: false,
    })
  })

  it("returns no_reservation when no wallet reservation exists", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    // Seed a meter window without a reservationId
    db.meterWindowRows.set(DEFAULT_METER_KEY, {
      meterKey: DEFAULT_METER_KEY,
      currency: "USD",
      priceConfig: DEFAULT_PRICE_CONFIG,
      periodEndAt: BASE_NOW + 60_000,
      usage: 0,
      updatedAt: BASE_NOW,
      createdAt: BASE_NOW,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.flushReservationForInvoicing({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result).toMatchObject({ ok: true, outcome: "no_reservation" })
    expect(testState.flushReservation).not.toHaveBeenCalled()
  })

  it("returns statement_mismatch when reservation belongs to a different statement", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    seedWalletReservation(db, {
      reservationId: "res_other",
      statementKey: "stmt_other",
      billingPeriodId: "bp_other",
      consumedAmount: 3 * 100_000_000,
      flushedAmount: 0,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.flushReservationForInvoicing({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result).toMatchObject({ ok: false, outcome: "statement_mismatch" })
    expect(testState.flushReservation).not.toHaveBeenCalled()
  })

  it("returns no_unflushed_usage when consumed equals flushed", async () => {
    const EntitlementWindowDO = await loadEntitlementWindowDO()
    const state = createDurableObjectState()
    const db = createFakeDbState()
    testState.db = db

    seedWalletReservation(db, {
      reservationId: "res_noop",
      statementKey: "stmt_123",
      consumedAmount: 5 * 100_000_000,
      flushedAmount: 5 * 100_000_000,
      consumedQuantity: 5,
      flushedQuantity: 5,
    })

    const durableObject = new EntitlementWindowDO(state, createEnv())
    const result = await durableObject.flushReservationForInvoicing({
      statementKey: "stmt_123",
      billingPeriodIds: ["bp_123"],
    })

    expect(result).toMatchObject({ ok: true, outcome: "no_unflushed_usage" })
    expect(testState.flushReservation).not.toHaveBeenCalled()
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
      public createReservation = testState.createReservation

      private lastCapture: {
        amount: number
        flushSeq: number
        statementKey: string
        metadata?: Record<string, unknown>
        sourceId?: string
      } | null = null

      public captureReservationUsage = vi.fn(
        async (input: {
          amount: number
          billingPeriodId?: string
          flushSeq: number
          kind?: string
          statementKey: string
          metadata?: Record<string, unknown>
          sourceId?: string
        }) => {
          this.lastCapture = {
            amount: input.amount,
            flushSeq: input.flushSeq,
            statementKey: input.statementKey,
            metadata: input.metadata,
            sourceId: input.sourceId,
          }
          testState.captureReservationUsage(input)
          return { err: null, val: { capturedAmount: input.amount } }
        }
      )

      public extendReservation = vi.fn(
        async (input: {
          projectId: string
          customerId: string
          currency: string
          reservationId: string
          flushSeq: number
          requestedAmount: number
          statementKey: string
          effectiveAt?: Date
          metadata?: Record<string, unknown>
          sourceId?: string
        }) => {
          const capture = this.lastCapture
          const result = await testState.flushReservation({
            projectId: input.projectId,
            customerId: input.customerId,
            currency: input.currency,
            reservationId: input.reservationId,
            flushSeq: input.flushSeq,
            flushAmount: capture?.amount ?? 0,
            refillChunkAmount: input.requestedAmount,
            effectiveAt: input.effectiveAt,
            statementKey: capture?.statementKey ?? input.statementKey,
            final: false,
            metadata: capture?.metadata ?? input.metadata,
            sourceId: capture?.sourceId ?? input.sourceId,
          })
          if (result.err) return result
          return {
            err: null,
            val: {
              grantedAmount: result.val.grantedAmount,
            },
          }
        }
      )

      public releaseReservation = vi.fn(
        async (input: {
          projectId: string
          customerId: string
          currency: string
          reservationId: string
          closeReason: string
          metadata?: Record<string, unknown>
          sourceId?: string
        }) => {
          const capture = this.lastCapture
          const result = await testState.flushReservation({
            projectId: input.projectId,
            customerId: input.customerId,
            currency: input.currency,
            reservationId: input.reservationId,
            flushSeq: capture?.flushSeq ?? 0,
            flushAmount: capture?.amount ?? 0,
            refillChunkAmount: 0,
            statementKey: capture?.statementKey ?? "",
            final: true,
            metadata: capture?.metadata ?? input.metadata,
            sourceId: capture?.sourceId ?? input.sourceId,
          })
          if (result.err) return result
          return {
            err: null,
            val: {
              releasedAmount: result.val.refundedAmount,
              restoredGrantedAmount: 0,
              refundedPurchasedAmount: result.val.refundedAmount,
            },
          }
        }
      )
    },
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
    lte: (_col: unknown, value: unknown): DrizzleCondition => ({ kind: "lte", value }),
    sql: () => ({ kind: "sql" }),
  }))

  vi.doMock("@unprice/analytics", () => ({
    Analytics: class {
      public ingestEntitlementMeterFacts = testState.analyticsIngest
    },
    entitlementMeterFactSchemaV1: z.object({}).passthrough(),
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
    creditLinePolicySchema: z.enum(["capped", "uncapped"]),
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

    const computeUsagePriceDeltaExplanation = (params: {
      priceConfig: unknown
      usageAfter: number
      usageBefore: number
    }) => {
      const amountMinor = computeUsagePriceDeltaMinor(params)

      return {
        amountMinor,
        usageBefore: Math.max(0, params.usageBefore),
        usageAfter: Math.max(0, params.usageAfter),
        tierMode: "graduated" as const,
        tierIndex: 7,
        pricingComponentCount: 9,
      }
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

    const computeGrantPeriodBucket = (
      grant: {
        effectiveAt: number
        expiresAt: number | null
        grantId: string
        resetConfig?: { resetInterval: string; resetIntervalCount?: number } | null
      },
      timestamp = Date.now()
    ) => {
      const interval = grant.resetConfig?.resetInterval ?? "onetime"
      if (interval === "month") {
        const count = grant.resetConfig?.resetIntervalCount ?? 1
        const effective = new Date(grant.effectiveAt)
        const at = new Date(timestamp)
        const monthDelta =
          (at.getUTCFullYear() - effective.getUTCFullYear()) * 12 +
          at.getUTCMonth() -
          effective.getUTCMonth()
        const periodIndex = Math.max(0, Math.floor(monthDelta / count) * count)
        const start = Date.UTC(
          effective.getUTCFullYear(),
          effective.getUTCMonth() + periodIndex,
          effective.getUTCDate(),
          effective.getUTCHours(),
          effective.getUTCMinutes(),
          effective.getUTCSeconds(),
          effective.getUTCMilliseconds()
        )
        const next = new Date(start)
        const end = Date.UTC(
          next.getUTCFullYear(),
          next.getUTCMonth() + count,
          next.getUTCDate(),
          next.getUTCHours(),
          next.getUTCMinutes(),
          next.getUTCSeconds(),
          next.getUTCMilliseconds()
        )
        const periodEnd = grant.expiresAt === null ? end : Math.min(end, grant.expiresAt)
        const periodKey = `${interval}:${start}`
        return {
          bucketKey: `${grant.grantId}:${periodKey}`,
          periodKey,
          start,
          end: periodEnd,
        }
      }

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
      timestamp?: number
    }) => {
      const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
      let available = 0

      for (const grant of params.grants) {
        const allowanceUnits = getGrantAllowance(grant)
        if (allowanceUnits === null) return Number.POSITIVE_INFINITY

        const bucket = computeGrantPeriodBucket(grant, params.timestamp)
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
      timestamp?: number
    }) => {
      const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
      return params.grants.reduce((total, grant) => {
        const bucket = computeGrantPeriodBucket(grant, params.timestamp)
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
      computeUsagePriceDeltaExplanation,
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
          const bucket = computeGrantPeriodBucket(grant, params.timestamp)
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
      apply: (input: ReturnType<typeof createApplyInput>) => Promise<{
        allowed: boolean
        deniedReason?: string
        message?: string
        meterFacts?: Record<string, unknown>[]
      }>
      getEnforcementState: (input?: unknown) => Promise<{
        isLimitReached: boolean
        limit: number | null
        spending: {
          currency: string
          ledgerAmount: number
          scale: number
        }
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
    idempotencyBatchRows: [],
    outboxBatchRows: [],
    meterWindowRows: new Map(),
    grantRows: new Map(),
    grantWindowRows: new Map(),
    periodUsageRows: new Map(),
    writeCounts: {
      idempotencyBatchRows: 0,
      outboxBatchRows: 0,
      grantWindowRows: 0,
      meterStateRows: 0,
      walletRows: 0,
    },
    deleteInArrayBatchSizes: [],
    deleteOutboxRangeMaxIds: [],
    storageReadCounts: {
      entitlementConfig: 0,
      grants: 0,
      grantWindows: 0,
    },
  }
}

function seedWalletReservation(db: FakeDbState, overrides: Partial<MeterWindowRow> = {}): void {
  db.meterWindowRows.set(DEFAULT_METER_KEY, {
    meterKey: DEFAULT_METER_KEY,
    currency: "USD",
    priceConfig: DEFAULT_PRICE_CONFIG,
    periodEndAt: BASE_NOW + 60_000,
    reservationEndAt: BASE_NOW + 60_000,
    usage: 0,
    updatedAt: BASE_NOW,
    createdAt: BASE_NOW,
    projectId: "proj_123",
    customerId: "cus_123",
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
    refillChunkAmount: 0,
    targetReservationAmount: 1_000_000_000,
    spendEwmaAmount: 0,
    lastRateSampledAtMs: BASE_NOW,
    maxEventCostAmount: 100_000_000,
    pendingRefillAmount: 0,
    pendingFlushAmount: null,
    pendingFlushQuantity: null,
    refillInFlight: false,
    flushSeq: 0,
    pendingFlushSeq: null,
    pendingFlushFinal: false,
    lastEventAt: BASE_NOW,
    lastFlushedAt: null,
    deletionRequested: false,
    recoveryRequired: false,
    ...overrides,
  })
}

function buildOutboxFact(index: number, now = BASE_NOW): Record<string, unknown> {
  return {
    event_id: `evt_${index}`,
    idempotency_key: `idem_${index}`,
    project_id: "proj_123",
    customer_id: "cus_123",
    currency: "USD",
    customer_entitlement_id: "ce_123",
    grant_id: "grant_123",
    feature_slug: "api_calls",
    period_key: "period_123",
    event_slug: "tokens_used",
    aggregation_method: "sum",
    timestamp: now,
    created_at: now,
    delta: 1,
    value_after: index,
    amount: 100_000_000,
    amount_after: 100_000_000,
    amount_scale: 8,
    priced_at: now,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 1,
  }
}

function pushOutboxBatchRow(db: FakeDbState, index: number, now = BASE_NOW): void {
  db.outboxBatchRows.push({
    id: index,
    payloads: JSON.stringify([buildOutboxFact(index, now)]),
    currency: "USD",
    createdAt: now,
  })
}

function pushIdempotencyBatchRow(
  db: FakeDbState,
  eventId: string,
  params: { createdAt: number; id: number }
): void {
  db.idempotencyBatchRows.push({
    id: params.id,
    createdAt: params.createdAt,
    entries: JSON.stringify([
      {
        eventId,
        createdAt: params.createdAt,
        allowed: true,
        deniedReason: null,
        denyMessage: null,
      },
    ]),
  })
}

function readOutboxPayloads(db: FakeDbState): Record<string, unknown>[] {
  const outboxPayloads = db.outboxBatchRows.flatMap(
    (row) => JSON.parse(row.payloads) as Record<string, unknown>[]
  )

  if (outboxPayloads.length > 0) {
    return outboxPayloads
  }

  return readIdempotencyMeterFacts(db)
}

function readIdempotencyMeterFacts(db: FakeDbState): Record<string, unknown>[] {
  return [...readIdempotencyEntries(db).values()].flatMap((entry) => entry.meterFacts ?? [])
}

function readIdempotencyEntries(db: FakeDbState): Map<string, IdempotencyRow> {
  const entries = new Map<string, IdempotencyRow>()

  for (const row of db.idempotencyBatchRows) {
    const batch = JSON.parse(row.entries) as Array<{
      eventId: string
      createdAt: number
      allowed: boolean
      deniedReason: string | null
      denyMessage: string | null
      meterFacts?: Record<string, unknown>[]
    }>

    for (const entry of batch) {
      entries.set(entry.eventId, {
        createdAt: entry.createdAt,
        allowed: entry.allowed,
        deniedReason: entry.deniedReason,
        denyMessage: entry.denyMessage,
        meterFacts: entry.meterFacts,
      })
    }
  }

  return entries
}

function readIdempotencyEntry(db: FakeDbState, eventId: string): IdempotencyRow | undefined {
  return readIdempotencyEntries(db).get(eventId)
}

/**
 * Builds a fake drizzle-compatible query builder backed by simple Maps/arrays.
 * Mirrors the subset of the drizzle API used by EntitlementWindowDO.
 */
function buildFakeDrizzle(state: FakeDbState) {
  let nextOutboxBatchId = 1
  let nextIdempotencyBatchId = 1

  const tableName = (table: unknown): string | null => {
    if (typeof table !== "object" || table === null) return null
    for (const symbol of Object.getOwnPropertySymbols(table)) {
      const value = (table as Record<symbol, unknown>)[symbol]
      if (typeof value === "string") {
        if (
          value === "meter_facts_outbox_batches" ||
          value === "idempotency_key_batches" ||
          value === "entitlement_period_usage" ||
          value === "grant_windows" ||
          value === "meter_state" ||
          value === "wallet_reservation"
        ) {
          return value
        }
      }
    }
    return null
  }

  const matchOutboxCondition = (row: { id: number }, condition?: DrizzleCondition): boolean => {
    if (!condition) return true
    switch (condition.kind) {
      case "and":
        return (condition.conditions ?? []).every((nested) => matchOutboxCondition(row, nested))
      case "eq":
        return row.id === Number(condition.value)
      case "inArray":
        return (condition.values ?? []).includes(row.id)
      case "lte":
        return row.id <= Number(condition.value)
      default:
        return true
    }
  }

  const matchGrantWindowCondition = (
    row: GrantWindowRow,
    condition?: DrizzleCondition
  ): boolean => {
    if (!condition) return true
    switch (condition.kind) {
      case "and":
        return (condition.conditions ?? []).every((nested) =>
          matchGrantWindowCondition(row, nested)
        )
      case "eq":
        return row.bucketKey === String(condition.value)
      case "inArray":
        return (condition.values ?? []).map(String).includes(row.bucketKey)
      default:
        return true
    }
  }

  const mirrorPeriodUsageStates = (row: PeriodUsageRow): void => {
    const states = JSON.parse(row.grantStatesJson) as GrantWindowRow[]
    for (const candidate of states) {
      state.grantWindowRows.set(candidate.bucketKey, {
        bucketKey: String(candidate.bucketKey),
        grantId: String(candidate.grantId),
        periodKey: String(candidate.periodKey),
        periodStartAt: Number(candidate.periodStartAt),
        periodEndAt: Number(candidate.periodEndAt),
        consumedInCurrentWindow: Number(candidate.consumedInCurrentWindow),
        exhaustedAt: candidate.exhaustedAt != null ? Number(candidate.exhaustedAt) : null,
      })
    }
  }

  const hydratePeriodUsageRowsFromGrantWindows = (): void => {
    const grouped = new Map<string, GrantWindowRow[]>()
    for (const row of state.grantWindowRows.values()) {
      const rows = grouped.get(row.periodKey) ?? []
      rows.push(row)
      grouped.set(row.periodKey, rows)
    }

    for (const [periodKey, rows] of grouped.entries()) {
      if (state.periodUsageRows.has(periodKey)) {
        continue
      }
      state.periodUsageRows.set(periodKey, {
        periodKey,
        periodStartAt: Math.min(...rows.map((row) => row.periodStartAt)),
        periodEndAt: Math.max(...rows.map((row) => row.periodEndAt)),
        grantStatesJson: JSON.stringify(rows),
        updatedAt: BASE_NOW,
      })
    }
  }

  const db = {
    transaction<T>(callback: (tx: typeof db) => T): T {
      const idempotencyBatchSnapshot = [...state.idempotencyBatchRows]
      const entitlementConfigSnapshot = new Map(state.entitlementConfigRows)
      const outboxBatchSnapshot = [...state.outboxBatchRows]
      const meterPricingSnapshot = new Map(state.meterWindowRows)
      const grantSnapshot = new Map(state.grantRows)
      const grantWindowSnapshot = new Map(state.grantWindowRows)
      const periodUsageSnapshot = new Map(state.periodUsageRows)
      const outboxBatchIdSnapshot = nextOutboxBatchId
      const idempotencyBatchIdSnapshot = nextIdempotencyBatchId
      try {
        return callback(db)
      } catch (error) {
        state.idempotencyBatchRows.splice(
          0,
          state.idempotencyBatchRows.length,
          ...idempotencyBatchSnapshot
        )
        state.entitlementConfigRows.clear()
        for (const [k, v] of Array.from(entitlementConfigSnapshot.entries()))
          state.entitlementConfigRows.set(k, v)
        state.outboxBatchRows.splice(0, state.outboxBatchRows.length, ...outboxBatchSnapshot)
        state.meterWindowRows.clear()
        for (const [k, v] of Array.from(meterPricingSnapshot.entries()))
          state.meterWindowRows.set(k, v)
        state.grantRows.clear()
        for (const [k, v] of Array.from(grantSnapshot.entries())) state.grantRows.set(k, v)
        state.grantWindowRows.clear()
        for (const [k, v] of Array.from(grantWindowSnapshot.entries()))
          state.grantWindowRows.set(k, v)
        state.periodUsageRows.clear()
        for (const [k, v] of Array.from(periodUsageSnapshot.entries()))
          state.periodUsageRows.set(k, v)
        nextOutboxBatchId = outboxBatchIdSnapshot
        nextIdempotencyBatchId = idempotencyBatchIdSnapshot
        throw error
      }
    },

    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields)
      let cond: DrizzleCondition | undefined
      let limitCount: number | undefined
      let orderDirection: "asc" | "desc" | undefined
      let sourceTable: string | null = null

      return {
        from(table?: unknown) {
          sourceTable = tableName(table)
          return this
        },
        where(c: DrizzleCondition) {
          cond = c
          return this
        },
        orderBy(order?: { kind?: string }) {
          orderDirection = order?.kind === "asc" || order?.kind === "desc" ? order.kind : undefined
          return this
        },
        limit(n: number) {
          limitCount = n
          return this
        },
        get() {
          if (sourceTable === "entitlement_period_usage") {
            hydratePeriodUsageRowsFromGrantWindows()
          }
          if (sourceTable === "idempotency_key_batches") {
            return undefined
          }
          if (keys.every((k) => ENTITLEMENT_CONFIG_KEYS.has(k))) {
            state.storageReadCounts.entitlementConfig++
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
          if (keys.every((k) => PERIOD_USAGE_KEYS.has(k))) {
            const rows = [...state.periodUsageRows.values()].sort((left, right) =>
              orderDirection === "desc"
                ? right.periodEndAt - left.periodEndAt
                : left.periodEndAt - right.periodEndAt
            )
            const source =
              cond?.value !== undefined ? state.periodUsageRows.get(String(cond.value)) : rows[0]
            if (!source) return undefined
            const row: Record<string, unknown> = {}
            for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
            return row
          }
          throw new Error(`Unsupported select().get(): ${keys}`)
        },
        all() {
          if (sourceTable === "entitlement_period_usage") {
            hydratePeriodUsageRowsFromGrantWindows()
          }
          if (sourceTable === "idempotency_key_batches") {
            if (keys.includes("entries")) {
              return state.idempotencyBatchRows
                .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
                .map((row) => ({ entries: row.entries }))
            }
            if (keys.includes("id")) {
              return state.idempotencyBatchRows
                .filter((row) => (cond?.kind === "lt" ? row.createdAt < Number(cond.value) : true))
                .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
                .map((row) => ({ id: row.id }))
            }
          }
          if (sourceTable === "meter_facts_outbox_batches") {
            if (keys.includes("payloads")) {
              return [...state.outboxBatchRows]
                .filter((row) => matchOutboxCondition(row, cond))
                .sort((a, b) => a.id - b.id)
                .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
                .map((row) => ({ id: row.id, payloads: row.payloads }))
            }
            if (keys.length === 1 && keys.includes("id")) {
              return [...state.outboxBatchRows]
                .filter((row) => matchOutboxCondition(row, cond))
                .sort((a, b) => a.id - b.id)
                .slice(0, limitCount ?? Number.POSITIVE_INFINITY)
                .map((row) => ({ id: row.id }))
            }
          }
          if (keys.every((k) => GRANT_WINDOW_KEYS.has(k))) {
            const rows = [...state.grantWindowRows.values()]
              .filter((row) => matchGrantWindowCondition(row, cond))
              .sort((a, b) => a.grantId.localeCompare(b.grantId))
            state.storageReadCounts.grantWindows += rows.length
            return rows.map((source) => {
              const row: Record<string, unknown> = {}
              for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
              return row
            })
          }
          if (
            sourceTable === "entitlement_period_usage" &&
            keys.every((k) => PERIOD_USAGE_KEYS.has(k))
          ) {
            const rows = [...state.periodUsageRows.values()].filter((row) => {
              if (!cond) return true
              if (cond.kind === "inArray") {
                return (cond.values ?? []).map(String).includes(row.periodKey)
              }
              if (cond.kind === "eq") {
                return row.periodKey === String(cond.value)
              }
              return true
            })
            state.storageReadCounts.grantWindows += rows.length
            return rows.map((source) => {
              const row: Record<string, unknown> = {}
              for (const key of keys) row[key] = (source as Record<string, unknown>)[key]
              return row
            })
          }
          if (keys.every((k) => GRANT_KEYS.has(k))) {
            state.storageReadCounts.grants++
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

    insert(table?: unknown) {
      const sourceTable = tableName(table)
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
                  billingPeriods: Array.isArray(value.billingPeriods) ? value.billingPeriods : [],
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
                  subscriptionItemId:
                    typeof value.subscriptionItemId === "string" ? value.subscriptionItemId : null,
                  addedAt: Number(value.addedAt),
                  updatedAt: Number(value.updatedAt),
                })
                return
              }
              if ("bucketKey" in value && "consumedInCurrentWindow" in value) {
                const key = String(value.bucketKey)
                if (state.grantWindowRows.has(key)) return
                state.writeCounts.grantWindowRows++
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
              if (sourceTable === "entitlement_period_usage" && "grantStatesJson" in value) {
                const key = String(value.periodKey)
                const row = {
                  periodKey: key,
                  periodStartAt: Number(value.periodStartAt),
                  periodEndAt: Number(value.periodEndAt),
                  grantStatesJson: String(value.grantStatesJson),
                  updatedAt: Number(value.updatedAt),
                }
                if (state.periodUsageRows.has(key)) return
                state.writeCounts.grantWindowRows++
                state.periodUsageRows.set(key, row)
                mirrorPeriodUsageStates(row)
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
              if (sourceTable === "meter_facts_outbox_batches" && "payloads" in value) {
                state.writeCounts.outboxBatchRows++
                state.outboxBatchRows.push({
                  id: nextOutboxBatchId++,
                  payloads: String(value.payloads),
                  currency: String(value.currency),
                  createdAt: Number(value.createdAt),
                })
                return
              }
              if (sourceTable === "idempotency_key_batches" && "entries" in value) {
                state.writeCounts.idempotencyBatchRows++
                state.idempotencyBatchRows.push({
                  id: nextIdempotencyBatchId++,
                  createdAt: Number(value.createdAt),
                  entries: String(value.entries),
                })
                return
              }
              if ("meterKey" in value) {
                const key = String(value.meterKey)
                if (state.meterWindowRows.has(key)) return
                state.writeCounts.meterStateRows++
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
                  billingPeriodId: (value.billingPeriodId as string | null | undefined) ?? null,
                  cycleEndAt: value.cycleEndAt != null ? Number(value.cycleEndAt) : null,
                  cycleStartAt: value.cycleStartAt != null ? Number(value.cycleStartAt) : null,
                  featurePlanVersionItemId:
                    (value.featurePlanVersionItemId as string | null | undefined) ?? null,
                  statementKey: (value.statementKey as string | null | undefined) ?? null,
                })
                return
              }
              if ("id" in value && "currency" in value && "reservationEndAt" in value) {
                state.writeCounts.walletRows++
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
                  billingPeriodId:
                    (value.billingPeriodId as string | null | undefined) ??
                    existing?.billingPeriodId ??
                    null,
                  cycleEndAt:
                    value.cycleEndAt != null
                      ? Number(value.cycleEndAt)
                      : (existing?.cycleEndAt ?? null),
                  cycleStartAt:
                    value.cycleStartAt != null
                      ? Number(value.cycleStartAt)
                      : (existing?.cycleStartAt ?? null),
                  featurePlanVersionItemId:
                    (value.featurePlanVersionItemId as string | null | undefined) ??
                    existing?.featurePlanVersionItemId ??
                    null,
                  featureSlug:
                    (value.featureSlug as string | null | undefined) ??
                    existing?.featureSlug ??
                    null,
                  statementKey:
                    (value.statementKey as string | null | undefined) ??
                    existing?.statementKey ??
                    null,
                  reservationId: existing?.reservationId ?? null,
                  allocationAmount: existing?.allocationAmount ?? 0,
                  consumedAmount: existing?.consumedAmount ?? 0,
                  flushedAmount: existing?.flushedAmount ?? 0,
                  consumedQuantity: existing?.consumedQuantity ?? 0,
                  flushedQuantity: existing?.flushedQuantity ?? 0,
                  refillThresholdBps: existing?.refillThresholdBps ?? 2000,
                  refillChunkAmount: existing?.refillChunkAmount ?? 0,
                  targetReservationAmount: existing?.targetReservationAmount ?? 0,
                  spendEwmaAmount: existing?.spendEwmaAmount ?? 0,
                  lastRateSampledAtMs: existing?.lastRateSampledAtMs ?? null,
                  maxEventCostAmount: existing?.maxEventCostAmount ?? 0,
                  pendingRefillAmount: existing?.pendingRefillAmount ?? 0,
                  pendingFlushAmount: existing?.pendingFlushAmount ?? null,
                  pendingFlushQuantity: existing?.pendingFlushQuantity ?? null,
                  refillInFlight: existing?.refillInFlight ?? false,
                  flushSeq: existing?.flushSeq ?? 0,
                  pendingFlushSeq: existing?.pendingFlushSeq ?? null,
                  pendingFlushFinal: existing?.pendingFlushFinal ?? false,
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

    update(table?: unknown) {
      const sourceTable = tableName(table)
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
              if (sourceTable === "entitlement_period_usage") {
                const periodKey = String(cond?.value ?? "")
                const row = state.periodUsageRows.get(periodKey)
                if (!row) return
                state.writeCounts.grantWindowRows++
                const nextRow = {
                  ...row,
                  periodStartAt:
                    patch.periodStartAt != null ? Number(patch.periodStartAt) : row.periodStartAt,
                  periodEndAt:
                    patch.periodEndAt != null ? Number(patch.periodEndAt) : row.periodEndAt,
                  grantStatesJson:
                    patch.grantStatesJson != null
                      ? String(patch.grantStatesJson)
                      : row.grantStatesJson,
                  updatedAt: patch.updatedAt != null ? Number(patch.updatedAt) : row.updatedAt,
                }
                state.periodUsageRows.set(periodKey, nextRow)
                mirrorPeriodUsageStates(nextRow)
                return
              }
              if ("consumedInCurrentWindow" in patch || "exhaustedAt" in patch) {
                const bucketKey = String(cond?.value ?? "")
                const row = state.grantWindowRows.get(bucketKey)
                if (!row) return
                state.writeCounts.grantWindowRows++
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
              const failure = state.failNextMeterWindowUpdate
              if (failure && failure.matchKey in patch) {
                state.failNextMeterWindowUpdate = undefined
                throw failure.error
              }
              if (sourceTable === "meter_state") {
                state.writeCounts.meterStateRows++
              } else if (sourceTable === "wallet_reservation") {
                state.writeCounts.walletRows++
              }
              Object.assign(first, patch)
            },
          }
        },
      }
    },

    delete(table?: unknown) {
      const sourceTable = tableName(table)
      return {
        where(cond: DrizzleCondition) {
          return {
            run() {
              if (cond.kind === "lte") {
                const maxId = Number(cond.value)
                state.deleteOutboxRangeMaxIds.push(maxId)
                if (sourceTable === "meter_facts_outbox_batches") {
                  const remaining = state.outboxBatchRows.filter((row) => row.id > maxId)
                  state.outboxBatchRows.splice(0, state.outboxBatchRows.length, ...remaining)
                  return
                }
                throw new Error(`Unsupported lte delete table: ${sourceTable}`)
              }

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
                if (sourceTable === "idempotency_key_batches") {
                  const remaining = state.idempotencyBatchRows.filter((r) => !ids.has(r.id))
                  state.idempotencyBatchRows.splice(
                    0,
                    state.idempotencyBatchRows.length,
                    ...remaining
                  )
                  return
                }
                throw new Error(`Unsupported numeric inArray delete table: ${sourceTable}`)
              }
              throw new Error("Unsupported non-numeric inArray delete")
            },
          }
        },
      }
    },
  }

  return db
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ1_URL: "postgres://user:pass@localhost:5432/unprice",
    DATABASE_READ2_URL: "postgres://user:pass@localhost:5432/unprice",
    DRIZZLE_LOG: false,
    TINYBIRD_TOKEN: "token",
    TINYBIRD_URL: "https://example.com",
    ...overrides,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, reject, resolve }
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
  const subscriptionItemId =
    typeof overrides.subscriptionItemId === "string" ? overrides.subscriptionItemId : "item_123"
  const billingPeriods = (overrides.billingPeriods as
    | Array<{
        billingPeriodId: string
        cycleEndAt: number
        cycleStartAt: number
        featurePlanVersionItemId: string
        statementKey: string
      }>
    | undefined) ?? [
    {
      billingPeriodId: "bp_123",
      cycleEndAt: periodEndAt,
      cycleStartAt: periodStartAt,
      featurePlanVersionItemId: subscriptionItemId,
      statementKey: "stmt_123",
    },
  ]
  const entitlement = {
    billingPeriods,
    creditLinePolicy:
      typeof overrides.creditLinePolicy === "string" ? overrides.creditLinePolicy : "capped",
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
    subscriptionItemId,
    ...((overrides.entitlement as Record<string, unknown> | undefined) ?? {}),
  }

  return {
    customerId,
    entitlement,
    enforceLimit: (overrides.enforceLimit as boolean | undefined) ?? false,
    event: {
      id: "evt_123",
      properties: { amount: 3 },
      source: {
        workspaceId: "ws_123",
        environment: "test",
        apiKeyId: "key_123",
        sourceType: "api_key",
        sourceId: "key_123",
        sourceName: null,
      },
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
