import { costPlusFeaturePolicySchema } from "@unprice/db/validators"
import { parseAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  buildRatePrice,
  earliestStart,
  formatMarginPolicy,
  markupPercent,
} from "~/components/pricing/rate-card-format"
import { policyDraftOf } from "./catalog-policy"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")

describe("buildRatePrice", () => {
  it("builds each price in the wire form publishRows takes", () => {
    const base = { amount: "0.02", per: "1000", property: "tokens", tiers: [] }
    expect(buildRatePrice({ ...base, shape: "unit" })).toEqual({
      ok: true,
      price: { type: "unit", components: [{ property: "tokens", rate: "0.02", per: 1000 }] },
    })
    expect(buildRatePrice({ ...base, shape: "package", property: "" })).toEqual({
      ok: true,
      price: { type: "package", property: null, size: 1000, rate: "0.02" },
    })
    expect(buildRatePrice({ ...base, shape: "flat", amount: "49" })).toEqual({
      ok: true,
      price: { type: "flat", amount: "49" },
    })
    expect(
      buildRatePrice({
        ...base,
        shape: "graduated",
        tiers: [
          { key: "a", upTo: "100", rate: "0", flat: "0" },
          { key: "b", upTo: "", rate: "0.01", flat: "5" },
        ],
      })
    ).toEqual({
      ok: true,
      price: {
        type: "graduated",
        property: "tokens",
        per: 1,
        tiers: [
          { upTo: 100, rate: "0", flat: "0" },
          { upTo: null, rate: "0.01", flat: "5" },
        ],
      },
    })
  })

  it("names what is missing instead of building a partial price", () => {
    expect(
      buildRatePrice({ shape: "graduated", amount: "", per: "1", property: "", tiers: [] })
    ).toMatchObject({ ok: false })
    expect(
      buildRatePrice({ shape: "unit", amount: "1", per: "0", property: "", tiers: [] })
    ).toMatchObject({ ok: false })
  })
})

describe("earliestStart", () => {
  it("lets a card's first rows start at once and gives later ones the notice", () => {
    expect(earliestStart(false, NOW, 600_000)).toBe(NOW)
    expect(earliestStart(true, NOW, 600_000)).toBe(NOW + 660_000)
  })
})

describe("markupPercent", () => {
  it.each([
    ["0.07", "7"],
    ["0.29", "29"],
    ["0.57", "57"],
  ])("formats %s exactly as %s percent", (rate, percent) => {
    const parsed = parseAmount(rate)
    if (!parsed.ok) throw new Error("Invalid test amount")
    const policy = costPlusFeaturePolicySchema.parse({
      featureSlug: "tokens",
      markup: rate,
      roundTo: "0.000001",
      dimension: "model",
      componentMap: { input: "input_tokens" },
    })
    expect(markupPercent(parsed.amount)).toBe(percent)
    expect(policyDraftOf(policy).markupPercent).toBe(percent)
    expect(formatMarginPolicy({ type: "costPlus", features: [policy] })).toBe(
      `Cost-plus ${percent}% on tokens`
    )
  })
})
