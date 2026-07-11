import { describe, expect, it, vi } from "vitest"
import { compactGrantConsumptionStateListSchema } from "./contracts"
import {
  parseCompactGrantStates,
  replaceGrantConsumptionState,
  selectGrantStatesForActiveGrants,
} from "./entitlement-window-store"
import { createGrantSnapshot } from "./entitlement-window-test-fixtures"

describe("entitlement window store helpers", () => {
  it("keeps the newest compact grant state per bucket key", () => {
    const states = [
      {
        bucketKey: "grant_a:period",
        consumedInCurrentWindow: 1,
        exhaustedAt: null,
        grantId: "grant_a",
        periodEndAt: 20,
        periodKey: "period",
        periodStartAt: 10,
      },
    ]

    replaceGrantConsumptionState(states, {
      bucketKey: "grant_a:period",
      consumedInCurrentWindow: 5,
      exhaustedAt: null,
      grantId: "grant_a",
      periodEndAt: 20,
      periodKey: "period",
      periodStartAt: 10,
    })

    expect(states).toHaveLength(1)
    expect(states[0]?.consumedInCurrentWindow).toBe(5)
  })

  it("returns an empty list and logs a warning for malformed compact grant state", () => {
    const logger = { warn: vi.fn() }
    const parsed = parseCompactGrantStates(
      "{bad json",
      compactGrantConsumptionStateListSchema,
      logger
    )

    expect(parsed).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      "skipping unparsable compact entitlement period state",
      expect.objectContaining({ error: expect.any(String) })
    )
  })

  it("returns an empty list and logs a warning for schema-invalid compact grant state", () => {
    const logger = { warn: vi.fn() }
    const parsed = parseCompactGrantStates(
      JSON.stringify([{ bucketKey: "missing-required-fields" }]),
      compactGrantConsumptionStateListSchema,
      logger
    )

    expect(parsed).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      "skipping malformed compact entitlement period state",
      expect.objectContaining({ error: expect.any(String) })
    )
  })

  it("selects only active grant buckets from retained period history", () => {
    const effectiveAt = Date.UTC(2026, 0, 1)
    const timestamp = effectiveAt + 1_000
    const grant = createGrantSnapshot({
      grantId: "grant_active",
      cadenceEffectiveAt: effectiveAt,
      effectiveAt,
      expiresAt: effectiveAt + 60_000,
    })
    const activeState = {
      bucketKey: `grant_active:onetime:${effectiveAt}`,
      consumedInCurrentWindow: 2,
      exhaustedAt: null,
      grantId: "grant_active",
      periodEndAt: effectiveAt + 60_000,
      periodKey: `onetime:${effectiveAt}`,
      periodStartAt: effectiveAt,
    }
    const historicalState = {
      ...activeState,
      bucketKey: `grant_historical:onetime:${effectiveAt - 60_000}`,
      grantId: "grant_historical",
      periodKey: `onetime:${effectiveAt - 60_000}`,
      periodStartAt: effectiveAt - 60_000,
    }

    expect(
      selectGrantStatesForActiveGrants([grant], [historicalState, activeState], timestamp)
    ).toEqual([activeState])
  })
})
