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
}

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
          if (keys.includes("periodEndAt") || keys.includes("usage")) {
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
