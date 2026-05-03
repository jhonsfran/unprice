import { describe, expect, it } from "vitest"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  DO_IDEMPOTENCY_TTL_MS,
  INGESTION_MAX_EVENT_AGE_MS,
  type MeterConfig,
  PeriodKeyComputationError,
  type RawEvent,
  type StorageAdapter,
  type SyncStorageAdapter,
  computePeriodKey,
  deriveMeterKey,
  validateEventTimestamp,
} from "./domain"
import { AsyncMeterAggregationEngine } from "./engine"

class InMemoryStorageAdapter implements StorageAdapter, SyncStorageAdapter {
  private readonly store = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    return this.getSync<T>(key)
  }

  getSync<T>(key: string): T | null {
    return (this.store.get(key) as T | undefined) ?? null
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.putSync(key, value)
  }

  putSync<T>(key: string, value: T): void {
    this.store.set(key, value)
  }

  async list<T>(prefix: string): Promise<T[]> {
    return this.listSync<T>(prefix)
  }

  listSync<T>(prefix: string): T[] {
    return Array.from(this.store.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as T)
  }
}

describe("validateEventTimestamp", () => {
  it("throws a future-specific error when the event is at least five seconds ahead", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)

    expect(() => validateEventTimestamp(serverTimeMs + 5_000, serverTimeMs)).toThrow(
      EventTimestampTooFarInFutureError
    )
  })

  it("throws an old-event error when the event is older than thirty days", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)
    const tooOldEventTimeMs = serverTimeMs - INGESTION_MAX_EVENT_AGE_MS - 1

    expect(() => validateEventTimestamp(tooOldEventTimeMs, serverTimeMs)).toThrow(
      EventTimestampTooOldError
    )
  })

  it("accepts timestamps inside the allowed window", () => {
    const serverTimeMs = Date.UTC(2026, 2, 8, 10, 0, 0)

    expect(() => validateEventTimestamp(serverTimeMs + 4_999, serverTimeMs)).not.toThrow()
    expect(() =>
      validateEventTimestamp(serverTimeMs - INGESTION_MAX_EVENT_AGE_MS, serverTimeMs)
    ).not.toThrow()
  })

  it("keeps DO idempotency retention wider than public ingestion acceptance", () => {
    expect(DO_IDEMPOTENCY_TTL_MS).toBeGreaterThan(INGESTION_MAX_EVENT_AGE_MS)
  })
})

describe("computePeriodKey", () => {
  it("uses the shared cycle window and returns interval:start for onetime plans", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 2, 8),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          anchor: "dayOfCreation",
          planType: "onetime",
        },
      })
    ).toBe(`onetime:${effectiveStartDate}`)
  })

  it("keeps the onetime key stable inside a finite one-time window", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1, 12, 0, 0)
    const effectiveEndDate = Date.UTC(2026, 1, 1, 12, 0, 0)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 0, 2, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          anchor: "dayOfCreation",
          planType: "onetime",
        },
      })
    ).toBe(`onetime:${effectiveStartDate}`)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 1, 1, 11, 59, 59),
        effectiveStartDate,
        effectiveEndDate,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          anchor: "dayOfCreation",
          planType: "onetime",
        },
      })
    ).toBe(`onetime:${effectiveStartDate}`)
  })

  it("returns interval:start for recurring month plans using the shared cycle logic", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1, 0, 0, 0)
    const now = Date.UTC(2026, 1, 20, 0, 0, 0)

    expect(
      computePeriodKey({
        now,
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          anchor: 15,
          planType: "recurring",
        },
      })
    ).toBe(`month:${Date.UTC(2026, 1, 15, 0, 0, 0)}`)
  })

  it("uses the paid-start stub for monthly cycles and rotates at the monthly anchor boundary", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 10, 0, 0, 0)
    const config = {
      name: "test",
      interval: "month" as const,
      intervalCount: 1,
      anchor: 15,
      planType: "recurring" as const,
    }

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 0, 12, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`month:${effectiveStartDate}`)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 0, 15, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`month:${Date.UTC(2026, 0, 15, 0, 0, 0)}`)
  })

  it("rotates daily period keys exactly at the configured reset hour", () => {
    const effectiveStartDate = Date.UTC(2026, 2, 1, 0, 0, 0)
    const config = {
      name: "test",
      interval: "day" as const,
      intervalCount: 1,
      anchor: 6,
      planType: "recurring" as const,
    }

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 2, 2, 5, 59, 59, 999),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`day:${Date.UTC(2026, 2, 1, 6, 0, 0)}`)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 2, 2, 6, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`day:${Date.UTC(2026, 2, 2, 6, 0, 0)}`)
  })

  it("supports custom recurring periods using intervalCount greater than one", () => {
    const effectiveStartDate = Date.UTC(2026, 0, 1, 0, 0, 0)
    const config = {
      name: "test",
      interval: "month" as const,
      intervalCount: 2,
      anchor: 10,
      planType: "recurring" as const,
    }

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 3, 10, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`month:${Date.UTC(2026, 2, 10, 0, 0, 0)}`)

    expect(
      computePeriodKey({
        now: Date.UTC(2026, 4, 10, 0, 0, 0),
        effectiveStartDate,
        effectiveEndDate: null,
        trialEndsAt: null,
        config,
      })
    ).toBe(`month:${Date.UTC(2026, 4, 10, 0, 0, 0)}`)
  })

  it("throws when there is no active cycle for the requested timestamp", () => {
    expect(() =>
      computePeriodKey({
        now: Date.UTC(2025, 11, 31, 23, 59, 59),
        effectiveStartDate: Date.UTC(2026, 0, 1, 0, 0, 0),
        effectiveEndDate: null,
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "month",
          intervalCount: 1,
          anchor: 15,
          planType: "recurring",
        },
      })
    ).toThrow(PeriodKeyComputationError)
  })

  it("throws for onetime plans when now hits the exclusive end boundary", () => {
    expect(() =>
      computePeriodKey({
        now: Date.UTC(2026, 1, 1, 12, 0, 0),
        effectiveStartDate: Date.UTC(2026, 0, 1, 12, 0, 0),
        effectiveEndDate: Date.UTC(2026, 1, 1, 12, 0, 0),
        trialEndsAt: null,
        config: {
          name: "test",
          interval: "onetime",
          intervalCount: 1,
          anchor: "dayOfCreation",
          planType: "onetime",
        },
      })
    ).toThrow(PeriodKeyComputationError)
  })
})

describe("deriveMeterKey", () => {
  it("only includes defined meter config parts in the key", () => {
    const meterConfig: MeterConfig = {
      eventId: "meter_projects",
      eventSlug: "project_event",
      aggregationMethod: "sum",
      aggregationField: "projects",
    }

    expect(deriveMeterKey(meterConfig)).toBe("slug=project_event|method=sum|field=projects")
  })
})

describe("AsyncMeterAggregationEngine", () => {
  it("aggregates sum, count, max, and latest meters for matching events", async () => {
    const storage = new InMemoryStorageAdapter()
    const meterConfigs = createMeterConfigs()
    const meterSum = meterConfigs[0]
    const meterCount = meterConfigs[1]
    const meterMax = meterConfigs[2]
    const meterLatest = meterConfigs[3]

    if (!meterSum || !meterCount || !meterMax || !meterLatest) {
      throw new Error("Missing default meter configs for test")
    }

    const engine = new AsyncMeterAggregationEngine(meterConfigs, storage, Date.now())
    const firstEvent = createPurchaseEvent({
      id: "evt_1",
      timestamp: Date.now() - 1_000,
      amount: 10,
    })
    const secondEvent = createPurchaseEvent({
      id: "evt_2",
      timestamp: Date.now(),
      amount: 4,
    })

    expect(await engine.applyEvent(firstEvent)).toEqual<Fact[]>([
      { eventId: "evt_1", meterKey: deriveMeterKey(meterSum), delta: 10, valueAfter: 10 },
      { eventId: "evt_1", meterKey: deriveMeterKey(meterCount), delta: 1, valueAfter: 1 },
      { eventId: "evt_1", meterKey: deriveMeterKey(meterMax), delta: 10, valueAfter: 10 },
      { eventId: "evt_1", meterKey: deriveMeterKey(meterLatest), delta: 10, valueAfter: 10 },
    ])

    expect(await engine.applyEvent(secondEvent)).toEqual<Fact[]>([
      { eventId: "evt_2", meterKey: deriveMeterKey(meterSum), delta: 4, valueAfter: 14 },
      { eventId: "evt_2", meterKey: deriveMeterKey(meterCount), delta: 1, valueAfter: 2 },
      { eventId: "evt_2", meterKey: deriveMeterKey(meterMax), delta: 0, valueAfter: 10 },
      { eventId: "evt_2", meterKey: deriveMeterKey(meterLatest), delta: -6, valueAfter: 4 },
    ])
  })

  it("throws when the numeric aggregation field is missing", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(
      [
        {
          eventId: "meter_sum",
          eventSlug: "purchase",
          aggregationMethod: "sum",
          aggregationField: "amount",
        },
      ],
      storage,
      Date.now()
    )

    await expect(
      engine.applyEvent({
        id: "evt_missing_amount",
        slug: "purchase",
        timestamp: Date.now(),
        properties: {},
      })
    ).rejects.toThrow("requires a finite numeric value")

    expect(await storage.list<number>("meter-state:")).toEqual([])
  })

  it("counts events without requiring aggregationField or numeric payload values", async () => {
    const storage = new InMemoryStorageAdapter()
    const meterConfig: MeterConfig = {
      eventId: "meter_count",
      eventSlug: "purchase",
      aggregationMethod: "count",
    }
    const engine = new AsyncMeterAggregationEngine([meterConfig], storage, Date.now())

    const facts = await engine.applyEvent({
      id: "evt_count_empty_payload",
      slug: "purchase",
      timestamp: Date.now(),
      properties: {},
    })

    expect(facts).toEqual([
      {
        eventId: "evt_count_empty_payload",
        meterKey: deriveMeterKey(meterConfig),
        delta: 1,
        valueAfter: 1,
      },
    ])
  })

  it("accepts parseable numeric strings for numeric aggregation fields", async () => {
    const storage = new InMemoryStorageAdapter()
    const meterConfig: MeterConfig = {
      eventId: "meter_latest",
      eventSlug: "purchase",
      aggregationMethod: "latest",
      aggregationField: "amount",
    }
    const engine = new AsyncMeterAggregationEngine([meterConfig], storage, Date.now())

    const facts = await engine.applyEvent({
      id: "evt_numeric_string_amount",
      slug: "purchase",
      timestamp: Date.now(),
      properties: {
        amount: "10.5",
      },
    })

    expect(facts).toEqual([
      {
        eventId: "evt_numeric_string_amount",
        meterKey: deriveMeterKey(meterConfig),
        delta: 10.5,
        valueAfter: 10.5,
      },
    ])
  })

  it("throws when numeric aggregation field is not a parseable finite number", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(
      [
        {
          eventId: "meter_latest",
          eventSlug: "purchase",
          aggregationMethod: "latest",
          aggregationField: "amount",
        },
      ],
      storage,
      Date.now()
    )

    await expect(
      engine.applyEvent({
        id: "evt_non_numeric_amount",
        slug: "purchase",
        timestamp: Date.now(),
        properties: {
          amount: "not_a_number",
        },
      })
    ).rejects.toThrow("requires a finite numeric value")

    expect(await storage.list<number>("meter-state:")).toEqual([])
  })

  it("does not let a stale LATEST event overwrite a newer value", async () => {
    const storage = new InMemoryStorageAdapter()
    const meterConfig: MeterConfig = {
      eventId: "meter_latest",
      eventSlug: "purchase",
      aggregationMethod: "latest",
      aggregationField: "amount",
    }
    const engine = new AsyncMeterAggregationEngine([meterConfig], storage, Date.now())

    const now = Date.now()

    await engine.applyEvent(
      createPurchaseEvent({
        id: "evt_new",
        timestamp: now,
        amount: 10,
      })
    )

    const facts = await engine.applyEvent(
      createPurchaseEvent({
        id: "evt_old",
        timestamp: now - 1_000,
        amount: 99,
      })
    )

    expect(facts).toEqual([
      { eventId: "evt_old", meterKey: deriveMeterKey(meterConfig), delta: 0, valueAfter: 10 },
    ])
  })

  it("does not persist sync state when pre-persist validation throws", () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(createMeterConfigs(), storage, Date.now())

    expect(() =>
      engine.applyEventSync(
        createPurchaseEvent({ id: "evt_denied", timestamp: Date.now(), amount: 10 }),
        {
          beforePersist: () => {
            throw new Error("denied")
          },
        }
      )
    ).toThrow("denied")

    expect(storage.listSync<number>("meter-state:")).toEqual([])
    expect(storage.listSync<number>("meter-state-updated-at:")).toEqual([])
  })

  it("does not persist async state when pre-persist validation rejects", async () => {
    const storage = new InMemoryStorageAdapter()
    const engine = new AsyncMeterAggregationEngine(createMeterConfigs(), storage, Date.now())

    await expect(
      engine.applyEvent(
        createPurchaseEvent({ id: "evt_denied_async", timestamp: Date.now(), amount: 10 }),
        {
          beforePersist: async () => {
            throw new Error("denied")
          },
        }
      )
    ).rejects.toThrow("denied")

    expect(await storage.list<number>("meter-state:")).toEqual([])
    expect(await storage.list<number>("meter-state-updated-at:")).toEqual([])
  })
})

function createMeterConfigs(): MeterConfig[] {
  return [
    {
      eventId: "meter_sum",
      eventSlug: "purchase",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    {
      eventId: "meter_count",
      eventSlug: "purchase",
      aggregationMethod: "count",
    },
    {
      eventId: "meter_max",
      eventSlug: "purchase",
      aggregationMethod: "max",
      aggregationField: "amount",
    },
    {
      eventId: "meter_latest",
      eventSlug: "purchase",
      aggregationMethod: "latest",
      aggregationField: "amount",
    },
  ]
}

function createPurchaseEvent({
  id,
  timestamp,
  amount,
}: {
  id: string
  timestamp: number
  amount: number
}): RawEvent {
  return {
    id,
    slug: "purchase",
    timestamp,
    properties: {
      amount,
    },
  }
}
