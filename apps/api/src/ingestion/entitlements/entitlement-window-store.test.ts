import { describe, expect, it, vi } from "vitest"
import { compactGrantConsumptionStateListSchema } from "./contracts"
import { parseCompactGrantStates, replaceGrantConsumptionState } from "./entitlement-window-store"

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
})
