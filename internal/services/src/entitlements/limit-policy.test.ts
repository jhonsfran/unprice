import { describe, expect, it } from "vitest"
import type { Fact } from "./domain"
import { findLimitExceededFact } from "./limit-policy"

function createFact(partial: Partial<Fact>): Fact {
  return {
    eventId: partial.eventId ?? "evt_1",
    meterKey: partial.meterKey ?? "meter_1",
    delta: partial.delta ?? 1,
    valueAfter: partial.valueAfter ?? 1,
  }
}

describe("findLimitExceededFact", () => {
  it("returns null when limit is missing or strategy is always", () => {
    const facts = [createFact({ delta: 10, valueAfter: 110 })]

    expect(findLimitExceededFact({ facts, limit: null, overageStrategy: "none" })).toBeNull()
    expect(findLimitExceededFact({ facts, limit: 100, overageStrategy: "always" })).toBeNull()
  })

  it("denies strict none strategy when positive delta pushes value above limit", () => {
    const facts = [createFact({ delta: 10, valueAfter: 110, meterKey: "meter_strict" })]

    expect(findLimitExceededFact({ facts, limit: 100, overageStrategy: "none" })).toEqual(facts[0])
  })

  it("treats zero as a valid finite limit", () => {
    const facts = [createFact({ delta: 1, valueAfter: 1 })]

    expect(findLimitExceededFact({ facts, limit: 0, overageStrategy: "none" })).toEqual(facts[0])
  })

  it("allows corrections even above limit when delta is non-positive", () => {
    const facts = [createFact({ delta: -5, valueAfter: 130 })]

    expect(findLimitExceededFact({ facts, limit: 100, overageStrategy: "none" })).toBeNull()
  })

  it("implements last-call behavior: deny only when previous value is already at or above limit", () => {
    const allowedFirstOverage = createFact({ delta: 50, valueAfter: 120 })
    const deniedSubsequent = createFact({ delta: 1, valueAfter: 121 })

    expect(
      findLimitExceededFact({
        facts: [allowedFirstOverage],
        limit: 100,
        overageStrategy: "last-call",
      })
    ).toBeNull()

    expect(
      findLimitExceededFact({
        facts: [deniedSubsequent],
        limit: 100,
        overageStrategy: "last-call",
      })
    ).toEqual(deniedSubsequent)
  })
})
