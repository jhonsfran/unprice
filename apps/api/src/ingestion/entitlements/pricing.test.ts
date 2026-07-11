import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type GrantConsumptionState,
  INGESTION_MAX_EVENT_AGE_MS,
  MAX_FUTURE_EVENT_SKEW_MS,
  type MeterConfig,
  computeGrantPeriodBucket,
  computeMeterTransition,
  deriveMeterKey,
} from "@unprice/services/entitlements"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyInputSchema } from "./contracts"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { resolveMeterIdentity } from "./meter-helpers"
import { InMemoryMeterStorageAdapter, type MeterStateDraft } from "./meter-state-adapter"
import { priceFactsFromGrantStates, projectEventCostMinor } from "./pricing"

const NOW = Date.now()

function createPricingFixture(overrides: Record<string, unknown> = {}) {
  const eventOverrides = (overrides.event as Record<string, unknown> | undefined) ?? {}
  const input = applyInputSchema.parse(
    createApplyInput({
      creditLinePolicy: "capped",
      limit: 10,
      now: NOW,
      periodEndAt: NOW + 60_000,
      periodStartAt: NOW - 60_000,
      ...overrides,
      event: { properties: { amount: 3 }, timestamp: NOW, ...eventOverrides },
    })
  )
  const grant = input.grants[0]
  if (!grant) throw new Error("Expected pricing fixture grant")
  const bucket = computeGrantPeriodBucket(grant, input.event.timestamp)
  if (!bucket) throw new Error("Expected pricing fixture grant bucket")

  const grantState: GrantConsumptionState = {
    bucketKey: bucket.bucketKey,
    consumedInCurrentWindow: 2,
    exhaustedAt: null,
    grantId: grant.grantId,
    periodEndAt: bucket.end,
    periodKey: bucket.periodKey,
    periodStartAt: bucket.start,
  }

  return {
    grantState,
    input,
    meter: resolveMeterIdentity(input.entitlement),
  }
}

describe("entitlement pricing", () => {
  it("prices against copied grant snapshots and returns the next state", () => {
    const { grantState, input } = createPricingFixture()
    const activeGrants = Object.freeze(input.grants.map((grant) => Object.freeze({ ...grant })))
    const grantStates = Object.freeze([Object.freeze({ ...grantState })])
    const before = structuredClone(grantStates)

    const result = priceFactsFromGrantStates({
      activeGrants,
      entitlement: input.entitlement,
      eventTimestamp: NOW,
      facts: [
        { eventId: "evt_1", meterKey: "meter", delta: 2, valueAfter: 4 },
        { eventId: "evt_2", meterKey: "meter", delta: 1, valueAfter: 5 },
      ],
      grantStates,
    })

    expect(grantStates).toEqual(before)
    expect(result.grantStates).not.toBe(grantStates)
    expect(result.grantStates[0]).toMatchObject({ consumedInCurrentWindow: 5 })
    expect(result.touchedStates.get(grantState.bucketKey)).toMatchObject({
      consumedInCurrentWindow: 5,
    })
    expect(
      result.pricedFacts.map(({ amountMinor, units, usageAfter, usageBefore }) => ({
        amountMinor,
        units,
        usageAfter,
        usageBefore,
      }))
    ).toEqual([
      { amountMinor: 200_000_000, units: 2, usageAfter: 4, usageBefore: 2 },
      { amountMinor: 100_000_000, units: 1, usageAfter: 5, usageBefore: 4 },
    ])
  })

  it("projects event cost without mutating meter or grant snapshots", () => {
    const { grantState, input, meter } = createPricingFixture()
    const grantStates = Object.freeze([Object.freeze({ ...grantState })])
    const meterState: Readonly<MeterStateDraft> = Object.freeze({
      createdAt: NOW - 1_000,
      dirty: false,
      exists: true,
      meterKey: meter.key,
      updatedAt: NOW - 1_000,
      usage: 2,
    })
    const grantStatesBefore = structuredClone(grantStates)
    const meterStateBefore = structuredClone(meterState)

    const projectedCost = projectEventCostMinor({
      activeGrants: input.grants,
      entitlement: input.entitlement,
      event: input.event,
      eventTimestamp: NOW,
      grantStates,
      meter,
      meterState,
      validationTimeMs: NOW,
    })

    expect(projectedCost).toBe(300_000_000)
    expect(grantStates).toEqual(grantStatesBefore)
    expect(meterState).toEqual(meterStateBefore)
  })
})

describe("projected meter transitions", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    {
      aggregationField: "amount",
      aggregationMethod: "sum" as const,
      expectedCost: 300_000_000,
      expectedDelta: 3,
      expectedValueAfter: 5,
    },
    {
      aggregationField: undefined,
      aggregationMethod: "count" as const,
      expectedCost: 100_000_000,
      expectedDelta: 1,
      expectedValueAfter: 3,
    },
    {
      aggregationField: "amount",
      aggregationMethod: "max" as const,
      expectedCost: 100_000_000,
      expectedDelta: 1,
      expectedValueAfter: 3,
    },
    {
      aggregationField: "amount",
      aggregationMethod: "latest" as const,
      expectedCost: 100_000_000,
      expectedDelta: 1,
      expectedValueAfter: 3,
    },
  ])(
    "matches the engine for $aggregationMethod aggregation",
    ({ aggregationField, aggregationMethod, expectedCost, expectedDelta, expectedValueAfter }) => {
      const fixture = createPricingFixture()
      const meterConfig: MeterConfig = {
        ...fixture.meter.config,
        aggregationMethod,
        ...(aggregationField ? { aggregationField } : { aggregationField: undefined }),
      }
      const meter = {
        ...fixture.meter,
        config: meterConfig,
        key: deriveMeterKey(meterConfig),
      }
      const meterState = createMeterState(meter.key)
      const currentState = { updatedAt: meterState.updatedAt!, value: meterState.usage }
      const transition = computeMeterTransition({
        currentState,
        event: fixture.input.event,
        meterConfig,
        validationTimeMs: NOW,
      })
      const engineFacts = new AsyncMeterAggregationEngine(
        [meterConfig],
        new InMemoryMeterStorageAdapter({ ...meterState }),
        NOW
      ).applyEventSync(fixture.input.event)
      const projectedCost = projectFixtureCost({ fixture, meter, meterState })

      expect(transition?.fact).toEqual({
        eventId: fixture.input.event.id,
        meterKey: deriveMeterKey(meterConfig),
        delta: expectedDelta,
        valueAfter: expectedValueAfter,
      })
      expect(engineFacts).toEqual([transition?.fact])
      expect(projectedCost).toBe(expectedCost)
    }
  )

  it("matches stale latest and slug-mismatch engine behavior", () => {
    const fixture = createPricingFixture({ event: { timestamp: NOW - 1_000 } })
    const latestConfig: MeterConfig = {
      ...fixture.meter.config,
      aggregationMethod: "latest",
      aggregationField: "amount",
    }
    const latestMeter = {
      ...fixture.meter,
      config: latestConfig,
      key: deriveMeterKey(latestConfig),
    }
    const meterState = createMeterState(latestMeter.key, { updatedAt: NOW })
    const currentState = { updatedAt: NOW, value: meterState.usage }
    const transition = computeMeterTransition({
      currentState,
      event: fixture.input.event,
      meterConfig: latestConfig,
      validationTimeMs: NOW,
    })
    const engineFacts = new AsyncMeterAggregationEngine(
      [latestConfig],
      new InMemoryMeterStorageAdapter({ ...meterState }),
      NOW
    ).applyEventSync(fixture.input.event)

    expect(transition?.fact).toMatchObject({ delta: 0, valueAfter: 2 })
    expect(engineFacts).toEqual([transition?.fact])
    expect(projectFixtureCost({ fixture, meter: latestMeter, meterState })).toBe(0)

    const mismatchedEvent = { ...fixture.input.event, slug: "other_event" }
    expect(
      computeMeterTransition({
        currentState,
        event: mismatchedEvent,
        meterConfig: latestConfig,
        validationTimeMs: NOW,
      })
    ).toBeNull()
    expect(
      new AsyncMeterAggregationEngine(
        [latestConfig],
        new InMemoryMeterStorageAdapter({ ...meterState }),
        NOW
      ).applyEventSync(mismatchedEvent)
    ).toEqual([])
    expect(
      projectFixtureCost({ fixture, meter: latestMeter, meterState, event: mismatchedEvent })
    ).toBe(0)
  })

  it.each([{ amount: undefined }, { amount: "not-a-number" }, { amount: Number.NaN }])(
    "matches invalid numeric field behavior for $amount",
    ({ amount }) => {
      const fixture = createPricingFixture({ event: { properties: { amount } } })
      const meterState = createMeterState(fixture.meter.key)
      const currentState = { updatedAt: meterState.updatedAt!, value: meterState.usage }

      expect(() =>
        computeMeterTransition({
          currentState,
          event: fixture.input.event,
          meterConfig: fixture.meter.config,
          validationTimeMs: NOW,
        })
      ).toThrow("requires a finite numeric value")
      expect(() =>
        new AsyncMeterAggregationEngine(
          [fixture.meter.config],
          new InMemoryMeterStorageAdapter({ ...meterState }),
          NOW
        ).applyEventSync(fixture.input.event)
      ).toThrow("requires a finite numeric value")
      expect(() => projectFixtureCost({ fixture, meterState })).toThrow(
        "requires a finite numeric value"
      )
    }
  )

  it.each([
    {
      accepted: true,
      label: "oldest accepted timestamp",
      timestamp: NOW - INGESTION_MAX_EVENT_AGE_MS,
    },
    {
      accepted: false,
      error: EventTimestampTooOldError,
      label: "one millisecond too old",
      timestamp: NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
    },
    {
      accepted: true,
      label: "latest accepted future timestamp",
      timestamp: NOW + MAX_FUTURE_EVENT_SKEW_MS - 1,
    },
    {
      accepted: false,
      error: EventTimestampTooFarInFutureError,
      label: "first rejected future timestamp",
      timestamp: NOW + MAX_FUTURE_EVENT_SKEW_MS,
    },
  ])("matches timestamp boundary behavior at $label", ({ accepted, error, timestamp }) => {
    const fixture = createPricingFixture({
      event: { timestamp },
      periodEndAt: NOW + MAX_FUTURE_EVENT_SKEW_MS + 1_000,
      periodStartAt: NOW - INGESTION_MAX_EVENT_AGE_MS - 1_000,
    })
    const meterState = createMeterState(fixture.meter.key, { updatedAt: timestamp - 1 })
    const currentState = { updatedAt: meterState.updatedAt!, value: meterState.usage }
    const runTransition = () =>
      computeMeterTransition({
        currentState,
        event: fixture.input.event,
        meterConfig: fixture.meter.config,
        validationTimeMs: NOW,
      })
    const runEngine = () =>
      new AsyncMeterAggregationEngine(
        [fixture.meter.config],
        new InMemoryMeterStorageAdapter({ ...meterState }),
        NOW
      ).applyEventSync(fixture.input.event)
    const runProjection = () => projectFixtureCost({ fixture, meterState })

    if (accepted) {
      expect(runTransition).not.toThrow()
      expect(runEngine).not.toThrow()
      expect(runProjection).not.toThrow()
      return
    }

    expect(runTransition).toThrow(error)
    expect(runEngine).toThrow(error)
    expect(runProjection).toThrow(error)
  })

  it("matches exhaustive unsupported aggregation behavior", () => {
    const fixture = createPricingFixture()
    const meterConfig = {
      ...fixture.meter.config,
      aggregationMethod: "median",
    } as unknown as MeterConfig
    const meter = {
      ...fixture.meter,
      config: meterConfig,
      key: deriveMeterKey(meterConfig),
    }
    const meterState = createMeterState(meter.key)
    const currentState = { updatedAt: meterState.updatedAt!, value: meterState.usage }

    expect(() =>
      computeMeterTransition({
        currentState,
        event: fixture.input.event,
        meterConfig,
        validationTimeMs: NOW,
      })
    ).toThrow("Unsupported aggregation method")
    expect(() =>
      new AsyncMeterAggregationEngine(
        [meterConfig],
        new InMemoryMeterStorageAdapter({ ...meterState }),
        NOW
      ).applyEventSync(fixture.input.event)
    ).toThrow("Unsupported aggregation method")
    expect(() => projectFixtureCost({ fixture, meter, meterState })).toThrow(
      "Unsupported aggregation method"
    )
  })
})

function createMeterState(
  meterKey: string,
  overrides: Partial<MeterStateDraft> = {}
): MeterStateDraft {
  return {
    createdAt: NOW - 1_000,
    dirty: false,
    exists: true,
    meterKey,
    updatedAt: NOW - 1_000,
    usage: 2,
    ...overrides,
  }
}

function projectFixtureCost(params: {
  event?: ReturnType<typeof createPricingFixture>["input"]["event"]
  fixture: ReturnType<typeof createPricingFixture>
  meter?: ReturnType<typeof createPricingFixture>["meter"]
  meterState: Readonly<MeterStateDraft>
}): number {
  const { fixture } = params
  return projectEventCostMinor({
    activeGrants: fixture.input.grants,
    entitlement: fixture.input.entitlement,
    event: params.event ?? fixture.input.event,
    eventTimestamp: (params.event ?? fixture.input.event).timestamp,
    grantStates: [fixture.grantState],
    meter: params.meter ?? fixture.meter,
    meterState: params.meterState,
    validationTimeMs: NOW,
  })
}
