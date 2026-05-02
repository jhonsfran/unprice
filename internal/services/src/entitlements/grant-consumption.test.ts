import type { ConfigFeatureVersionType, ResetConfig } from "@unprice/db/validators"
import { dinero } from "dinero.js"
import { EUR, USD } from "dinero.js/currencies"
import { describe, expect, it } from "vitest"
import {
  type GrantConsumptionGrant,
  type GrantConsumptionState,
  computeGrantPeriodBucket,
  computeMaxMarginalPriceMinor,
  computeUsagePriceDeltaMinor,
  consumeGrantsByPriority,
} from "./grant-consumption"

describe("consumeGrantsByPriority", () => {
  const now = Date.UTC(2026, 2, 19, 12, 0, 0)
  const grantStart = now - 1000
  const entitlementMonthEnd = Date.UTC(2026, 3, 19, 0, 0, 0)

  const monthlyReset: ResetConfig = {
    name: "monthly",
    planType: "recurring",
    resetAnchor: 1,
    resetInterval: "month",
    resetIntervalCount: 1,
  }

  const grant = (overrides: Partial<GrantConsumptionGrant> = {}): GrantConsumptionGrant => ({
    grantId: "grant_a",
    allowanceUnits: 100,
    effectiveAt: grantStart,
    expiresAt: null,
    priority: 10,
    resetConfig: null,
    ...overrides,
  })

  const state = (overrides: Partial<GrantConsumptionState> = {}): GrantConsumptionState => ({
    bucketKey: `${overrides.grantId ?? "grant_a"}:${overrides.periodKey ?? `onetime:${grantStart}`}`,
    consumedInCurrentWindow: 0,
    exhaustedAt: null,
    grantId: "grant_a",
    periodEndAt: Number.MAX_SAFE_INTEGER,
    periodKey: `onetime:${grantStart}`,
    periodStartAt: grantStart,
    ...overrides,
  })

  it("returns the requested units as remaining when there are no grants", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 7,
      grants: [],
      states: [],
    })

    expect(result).toEqual({ allocations: [], remaining: 7 })
  })

  it("ignores zero and negative unit deltas", () => {
    expect(
      consumeGrantsByPriority({
        timestamp: now,
        units: 0,
        grants: [grant()],
        states: [],
      })
    ).toEqual({ allocations: [], remaining: 0 })

    expect(
      consumeGrantsByPriority({
        timestamp: now,
        units: -3,
        grants: [grant()],
        states: [],
      })
    ).toEqual({ allocations: [], remaining: -3 })
  })

  it("creates an empty state when a grant has no stored state", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 4,
      grants: [grant()],
      states: [],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]?.nextState).toEqual({
      bucketKey: `grant_a:onetime:${grantStart}`,
      consumedInCurrentWindow: 4,
      exhaustedAt: null,
      grantId: "grant_a",
      periodEndAt: Number.MAX_SAFE_INTEGER,
      periodKey: `onetime:${grantStart}`,
      periodStartAt: grantStart,
    })
  })

  it("consumes active grants by priority and returns attribution", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 12,
      grants: [
        grant({ grantId: "low", allowanceUnits: 100, priority: 10 }),
        grant({ grantId: "high", allowanceUnits: 5, priority: 20 }),
      ],
      states: [
        state({ bucketKey: `low:onetime:${grantStart}`, grantId: "low" }),
        state({ bucketKey: `high:onetime:${grantStart}`, grantId: "high" }),
      ],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations.map((allocation) => allocation.grant.grantId)).toEqual([
      "high",
      "low",
    ])
    expect(result.allocations.map((allocation) => allocation.units)).toEqual([5, 7])
  })

  it("breaks priority ties by earliest expiry and then grant id", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 3,
      grants: [
        grant({ grantId: "z_unbounded", allowanceUnits: 1, expiresAt: null, priority: 10 }),
        grant({ grantId: "b_same_expiry", allowanceUnits: 1, expiresAt: now + 5000, priority: 10 }),
        grant({ grantId: "a_earliest", allowanceUnits: 1, expiresAt: now + 1000, priority: 10 }),
        grant({ grantId: "a_same_expiry", allowanceUnits: 1, expiresAt: now + 5000, priority: 10 }),
      ],
      states: [],
    })

    expect(result.allocations.map((allocation) => allocation.grant.grantId)).toEqual([
      "a_earliest",
      "a_same_expiry",
      "b_same_expiry",
    ])
  })

  it("ignores future and expired grants", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 4,
      grants: [
        grant({ grantId: "future", effectiveAt: now + 1, priority: 100 }),
        grant({ grantId: "expired", effectiveAt: now - 2000, expiresAt: now, priority: 90 }),
        grant({ grantId: "active", priority: 10 }),
      ],
      states: [
        state({ bucketKey: `future:onetime:${now + 1}`, grantId: "future" }),
        state({ bucketKey: `expired:onetime:${now - 2000}`, grantId: "expired" }),
        state({ bucketKey: `active:onetime:${grantStart}`, grantId: "active" }),
      ],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]?.grant.grantId).toBe("active")
  })

  it("skips exhausted included capacity but still uses the grant for overage attribution", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 4,
      grants: [grant({ allowanceUnits: 5 })],
      states: [
        state({
          consumedInCurrentWindow: 5,
          exhaustedAt: now - 1,
        }),
      ],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]).toEqual(
      expect.objectContaining({
        units: 4,
        usageBefore: 5,
        usageAfter: 9,
      })
    )
  })

  it("uses the remaining finite capacity before moving to the next grant", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 10,
      grants: [
        grant({ grantId: "nearly_empty", allowanceUnits: 8, priority: 20 }),
        grant({ grantId: "fallback", allowanceUnits: 100, priority: 10 }),
      ],
      states: [
        state({
          bucketKey: `nearly_empty:onetime:${grantStart}`,
          grantId: "nearly_empty",
          consumedInCurrentWindow: 6,
        }),
        state({ bucketKey: `fallback:onetime:${grantStart}`, grantId: "fallback" }),
      ],
    })

    expect(result.allocations.map((allocation) => allocation.units)).toEqual([2, 8])
    expect(result.allocations[0]?.nextState.exhaustedAt).toBe(now)
    expect(result.allocations[1]?.nextState.consumedInCurrentWindow).toBe(8)
  })

  it("attributes overage to the first eligible grant when included capacity is exhausted", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 8,
      grants: [grant({ grantId: "primary", allowanceUnits: 5, priority: 20 })],
      states: [state({ bucketKey: `primary:onetime:${grantStart}`, grantId: "primary" })],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations.map((allocation) => allocation.units)).toEqual([5, 3])
    expect(result.allocations.map((allocation) => allocation.usageBefore)).toEqual([0, 5])
    expect(result.allocations.map((allocation) => allocation.usageAfter)).toEqual([5, 8])
    expect(result.allocations.at(-1)?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 8,
        exhaustedAt: now,
      })
    )
  })

  it("returns remaining units when no grant is eligible", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 9,
      grants: [grant({ grantId: "expired", expiresAt: now })],
      states: [state({ bucketKey: `expired:onetime:${grantStart}`, grantId: "expired" })],
    })

    expect(result).toEqual({ allocations: [], remaining: 9 })
  })

  it("lets unlimited grants consume the whole delta", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 250,
      grants: [grant({ allowanceUnits: null })],
      states: [state()],
    })

    expect(result.remaining).toBe(0)
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]?.units).toBe(250)
    expect(result.allocations[0]?.nextState.exhaustedAt).toBeNull()
  })

  it("marks non-reset grants exhausted when they reach their allowanceUnits", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 2,
      grants: [grant({ allowanceUnits: 5, resetConfig: undefined })],
      states: [state({ consumedInCurrentWindow: 3 })],
    })

    expect(result.allocations[0]?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 5,
        exhaustedAt: now,
      })
    )
  })

  it("marks the current reset bucket exhausted at the window limit", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 5,
      grants: [grant({ allowanceUnits: 5, resetConfig: monthlyReset })],
      states: [
        state({
          bucketKey: `grant_a:month:${grantStart}`,
          periodKey: `month:${grantStart}`,
          periodStartAt: grantStart,
          periodEndAt: entitlementMonthEnd,
        }),
      ],
    })

    expect(result.allocations[0]?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 5,
        exhaustedAt: now,
      })
    )
  })

  it("initializes a reset window when the grant has no window state", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 3,
      grants: [grant({ resetConfig: monthlyReset })],
      states: [state()],
    })

    expect(result.allocations[0]?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 3,
        periodKey: `month:${grantStart}`,
        periodStartAt: grantStart,
        periodEndAt: entitlementMonthEnd,
      })
    )
  })

  it("creates a new reset bucket at the window boundary", () => {
    const result = consumeGrantsByPriority({
      timestamp: entitlementMonthEnd,
      units: 4,
      grants: [grant({ resetConfig: monthlyReset })],
      states: [
        state({
          bucketKey: `grant_a:month:${grantStart}`,
          periodKey: `month:${grantStart}`,
          periodStartAt: grantStart,
          periodEndAt: entitlementMonthEnd,
          consumedInCurrentWindow: 99,
        }),
      ],
    })

    expect(result.allocations[0]?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 4,
        periodKey: `month:${entitlementMonthEnd}`,
        periodStartAt: entitlementMonthEnd,
        periodEndAt: Date.UTC(2026, 4, 19, 0, 0, 0),
      })
    )
  })

  it("keeps reset grants in the current window before the boundary", () => {
    const result = consumeGrantsByPriority({
      timestamp: now,
      units: 4,
      grants: [grant({ resetConfig: monthlyReset })],
      states: [
        state({
          bucketKey: `grant_a:month:${grantStart}`,
          periodKey: `month:${grantStart}`,
          periodStartAt: grantStart,
          periodEndAt: entitlementMonthEnd,
          consumedInCurrentWindow: 6,
        }),
      ],
    })

    expect(result.allocations[0]?.usageBefore).toBe(6)
    expect(result.allocations[0]?.nextState).toEqual(
      expect.objectContaining({
        consumedInCurrentWindow: 10,
        periodKey: `month:${grantStart}`,
        periodStartAt: grantStart,
        periodEndAt: entitlementMonthEnd,
      })
    )
  })

  it("returns one-time buckets for non-reset grants", () => {
    expect(computeGrantPeriodBucket(grant({ resetConfig: null }), now)).toEqual({
      bucketKey: `grant_a:onetime:${grantStart}`,
      periodKey: `onetime:${grantStart}`,
      start: grantStart,
      end: Number.MAX_SAFE_INTEGER,
    })
  })

  it("returns reset bucket boundaries for reset grants", () => {
    expect(computeGrantPeriodBucket(grant({ resetConfig: monthlyReset }), now)).toEqual({
      bucketKey: `grant_a:month:${grantStart}`,
      periodKey: `month:${grantStart}`,
      start: grantStart,
      end: entitlementMonthEnd,
    })
  })

  it("uses the entitlement cadence start when calculating reset buckets", () => {
    const effectiveAt = Date.UTC(2026, 2, 1, 0, 0, 0)
    const anchoredStart = Date.UTC(2026, 2, 15, 0, 0, 0)
    const anchoredEnd = Date.UTC(2026, 3, 15, 0, 0, 0)

    expect(
      computeGrantPeriodBucket(
        grant({
          cadenceEffectiveAt: anchoredStart,
          effectiveAt,
          resetConfig: monthlyReset,
        }),
        now
      )
    ).toEqual({
      bucketKey: `grant_a:month:${anchoredStart}`,
      periodKey: `month:${anchoredStart}`,
      start: anchoredStart,
      end: anchoredEnd,
    })
  })
})

describe("grant pricing helpers", () => {
  const price = (
    displayAmount: string,
    currency: typeof USD | typeof EUR = USD
  ): ConfigFeatureVersionType["price"] => ({
    dinero: dinero({ amount: 0, currency }).toJSON(),
    displayAmount,
  })

  it("prices usage deltas at ledger scale", () => {
    const priceConfig = {
      usageMode: "unit",
      price: price("1.00"),
    } as ConfigFeatureVersionType

    expect(
      computeUsagePriceDeltaMinor({
        priceConfig,
        usageBefore: 2,
        usageAfter: 5,
      })
    ).toBe(300_000_000)
  })

  it("includes flat tier jumps when sizing the max marginal price", () => {
    const priceConfig = {
      tierMode: "volume",
      usageMode: "tier",
      tiers: [
        {
          firstUnit: 1,
          lastUnit: 30,
          unitPrice: price("0.00", EUR),
          flatPrice: price("0.00", EUR),
        },
        {
          firstUnit: 31,
          lastUnit: null,
          unitPrice: price("0.001", EUR),
          flatPrice: price("1.00", EUR),
        },
      ],
    } as ConfigFeatureVersionType

    expect(
      computeUsagePriceDeltaMinor({
        priceConfig,
        usageBefore: 30,
        usageAfter: 31,
      })
    ).toBe(103_100_000)
    expect(computeMaxMarginalPriceMinor(priceConfig)).toBe(103_100_000)
  })
})
