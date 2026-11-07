import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { dimensionsOf, tiersText } from "./publish-rows-dialog"
import { buildRatePrice } from "./rate-card-format"

function row(featureSlug: string, match: Record<string, string>) {
  return rateRowSchema.parse({
    id: `rr_${featureSlug}_${Object.values(match).join("_") || "default"}`,
    rateCardId: "rc_1",
    featureSlug,
    match,
    price: { type: "flat", amount: "1" },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}

describe("tiersText", () => {
  it("writes the tier editor's rows as the publish form reads them, the last one open", () => {
    const text = tiersText([
      { key: "a", upTo: "1000", unitPrice: "0", flatPrice: "" },
      { key: "b", upTo: "", unitPrice: "0.01", flatPrice: "0" },
    ])

    expect(text).toBe("1000 0 0\n* 0.01 0")
    expect(
      buildRatePrice({ kind: "graduated", amount: "", per: "1", property: "", tiers: text }).ok
    ).toBe(true)
  })
})

describe("dimensionsOf", () => {
  it("lists the properties a feature's prices vary by, with their values", () => {
    const rows = [
      row("model_tokens", { model: "gpt-4o" }),
      row("model_tokens", { model: "claude-opus-5" }),
      row("requests", {}),
    ]

    expect(dimensionsOf(rows, "model_tokens")).toEqual([
      { key: "model", values: ["claude-opus-5", "gpt-4o"] },
    ])
    expect(dimensionsOf(rows, "requests")).toEqual([])
  })
})
