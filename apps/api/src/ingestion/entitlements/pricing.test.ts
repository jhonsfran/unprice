import {
  type GrantConsumptionState,
  computeGrantPeriodBucket,
} from "@unprice/services/entitlements"
import { describe, expect, it } from "vitest"
import { applyInputSchema } from "./contracts"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { resolveMeterIdentity } from "./meter-helpers"
import type { MeterStateDraft } from "./meter-state-adapter"
import { priceFactsFromGrantStates, projectEventCostMinor } from "./pricing"

const NOW = Date.now()

function createPricingFixture() {
  const input = applyInputSchema.parse(
    createApplyInput({
      creditLinePolicy: "capped",
      event: { properties: { amount: 3 }, timestamp: NOW },
      limit: 10,
      timestampValidationNow: NOW,
      periodEndAt: NOW + 60_000,
      periodStartAt: NOW - 60_000,
    })
  )
  const grant = input.grants[0]
  if (!grant) throw new Error("Expected pricing fixture grant")
  const bucket = computeGrantPeriodBucket(grant, NOW)
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
      now: NOW,
    })

    expect(projectedCost).toBe(300_000_000)
    expect(grantStates).toEqual(grantStatesBefore)
    expect(meterState).toEqual(meterStateBefore)
  })
})
