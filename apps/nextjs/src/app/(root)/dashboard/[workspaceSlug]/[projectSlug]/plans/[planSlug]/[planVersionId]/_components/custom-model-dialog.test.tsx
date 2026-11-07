import { describe, expect, it } from "vitest"
import { isCustomCostRow } from "../../../../rate-cards/_components/rate-card-format"
import { pricedAt } from "./custom-model-dialog"

describe("pricedAt", () => {
  it("shows what a cost becomes at the markup, before the card's rounding", () => {
    expect(pricedAt("1.2", "20")).toBe("1.44")
    expect(pricedAt("0.15", "30")).toBe("0.195")
    expect(pricedAt("", "20")).toBeNull()
    expect(pricedAt("-1", "20")).toBeNull()
  })
})

describe("isCustomCostRow", () => {
  it("tells a row priced from the project's own cost from a models.dev one", () => {
    expect(isCustomCostRow({ source: "catalog", sourceRef: "cmc_123" })).toBe(true)
    expect(isCustomCostRow({ source: "catalog", sourceRef: "mc_123" })).toBe(false)
    expect(isCustomCostRow({ source: "manual", sourceRef: "cmc_123" })).toBe(false)
    expect(isCustomCostRow({ source: "catalog", sourceRef: null })).toBe(false)
  })
})
