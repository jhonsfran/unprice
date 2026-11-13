import type { ResetConfig } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { type GrantConsumptionGrant, computeGrantPeriodBucket } from "./grant-consumption"

describe("computeGrantPeriodBucket", () => {
  const now = Date.UTC(2026, 2, 19, 12, 0, 0)
  const grantCycleStart = Date.UTC(2026, 2, 19, 0, 0, 0)
  const grantStart = grantCycleStart
  const entitlementMonthEnd = Date.UTC(2026, 3, 19, 0, 0, 0)

  const monthlyReset: ResetConfig = {
    name: "monthly",
    planType: "recurring",
    resetAnchor: "dayOfCreation",
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
      bucketKey: `grant_a:month:${grantCycleStart}`,
      periodKey: `month:${grantCycleStart}`,
      start: grantCycleStart,
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

  it("preserves the creation time for monthly day-of-creation reset buckets", () => {
    const cadenceStart = Date.UTC(2026, 7, 11, 17, 0, 0)
    const cadenceEnd = Date.UTC(2026, 8, 11, 17, 0, 0)

    expect(
      computeGrantPeriodBucket(
        grant({
          cadenceEffectiveAt: cadenceStart,
          resetConfig: monthlyReset,
        }),
        Date.UTC(2026, 7, 25, 12, 0, 0)
      )
    ).toEqual({
      bucketKey: `grant_a:month:${cadenceStart}`,
      periodKey: `month:${cadenceStart}`,
      start: cadenceStart,
      end: cadenceEnd,
    })
  })

  it("uses an explicit monthly reset anchor", () => {
    const cadenceStart = Date.UTC(2026, 7, 11, 17, 0, 0)
    const anchoredEnd = Date.UTC(2026, 8, 1, 0, 0, 0)

    expect(
      computeGrantPeriodBucket(
        grant({
          cadenceEffectiveAt: cadenceStart,
          resetConfig: {
            ...monthlyReset,
            resetAnchor: 1,
          },
        }),
        Date.UTC(2026, 7, 25, 12, 0, 0)
      )
    ).toEqual({
      bucketKey: `grant_a:month:${cadenceStart}`,
      periodKey: `month:${cadenceStart}`,
      start: cadenceStart,
      end: anchoredEnd,
    })
  })
})
