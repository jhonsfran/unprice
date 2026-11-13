import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { buildRatePrice } from "~/components/pricing/rate-card-format"
import { dimensionsOf } from "./publish-rows-dialog"

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

describe("publish tiers", () => {
  it("writes the tier editor's rows as the publish form reads them, the last one open", () => {
    const tiers = [
      { key: "a", upTo: "1000", rate: "0", flat: "" },
      { key: "b", upTo: "", rate: "0.01", flat: "0" },
    ]
    expect(
      buildRatePrice({ shape: "graduated", amount: "", per: "1", property: "", tiers })
    ).toEqual({
      ok: true,
      price: {
        type: "graduated",
        property: null,
        per: 1,
        tiers: [
          { upTo: 1000, rate: "0", flat: "0" },
          { upTo: null, rate: "0.01", flat: "0" },
        ],
      },
    })
  })
  it("refuses decreasing bounds before publishing a tier price", () => {
    expect(
      buildRatePrice({
        shape: "graduated",
        amount: "",
        per: "1",
        property: "",
        tiers: [
          { key: "a", upTo: "100", rate: "0", flat: "0" },
          { key: "b", upTo: "50", rate: "1", flat: "0" },
          { key: "c", upTo: "", rate: "2", flat: "0" },
        ],
      })
    ).toEqual({ ok: false, message: "Tier 2 ends at a whole number of at least 101." })
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
