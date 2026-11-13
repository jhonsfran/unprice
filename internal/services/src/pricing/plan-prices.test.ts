import { rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { isVersionCard } from "../rate-cards/price-plan-version"
import {
  decimalPriceOf,
  describePlanFeatureLine,
  featureRow,
  planVersionPrices,
  ratePriceOf,
  tierRanges,
  versionReadiness,
} from "./plan-prices"

const features = [{ feature: { slug: "calls" } }, { feature: { slug: "support" } }]
const row = rateRowSchema.parse({
  id: "rr_1",
  rateCardId: "rc_1",
  featureSlug: "calls",
  match: {},
  price: { type: "flat", amount: "0" },
  cost: null,
  effectiveFrom: 200,
  effectiveTo: null,
  source: "manual",
  sourceRef: null,
})

describe("versionReadiness", () => {
  it("requires the selected currency's card, even when another card has all rows", () => {
    expect(versionReadiness(features, undefined, 100)).toEqual({
      hasCard: false,
      unpricedFeatureSlugs: ["calls", "support"],
    })
  })
  it("accepts scheduled and dimension rows, excludes ended rows and ignores other features", () => {
    expect(
      versionReadiness(
        features,
        { rows: [row, { ...row, featureSlug: "support", effectiveTo: 100 }] },
        100
      )
    ).toEqual({ hasCard: true, unpricedFeatureSlugs: ["support"] })
    expect(
      versionReadiness(
        features,
        { rows: [row, { ...row, featureSlug: "support", match: { model: "a" } }] },
        100
      )
    ).toEqual({ hasCard: true, unpricedFeatureSlugs: [] })
  })
})

it("identifies only the version's complete canonical card name", () => {
  const version = { planSlug: "pro_ai", planVersionId: "pv_1", currency: "USD" as const }
  expect(isVersionCard({ name: "pro_ai pv_1 USD" }, version)).toBe(true)
  expect(isVersionCard({ name: "pro_ai pv_10 USD" }, version)).toBe(false)
  expect(isVersionCard({ name: "pro_ai pv_1 EUR" }, version)).toBe(false)
})

it("round-trips decimal tier rows without inventing inclusive input bounds", () => {
  const price = ratePriceOf(
    {
      featureType: "tier",
      tiers: [
        { upTo: 10, rate: "0", flat: "0" },
        { upTo: null, rate: "2", flat: "1" },
      ],
    },
    null
  )
  if (!price) throw new Error("fixture")
  expect(decimalPriceOf(price)).toEqual({
    tiers: [
      { upTo: 10, rate: "0", flat: "0" },
      { upTo: null, rate: "2", flat: "1" },
    ],
  })
  expect(tierRanges([{ upTo: 10 }, { upTo: null }])).toEqual([
    { from: 1, upTo: 10 },
    { from: 11, upTo: null },
  ])
})

it("never chooses one model as a feature's default price", () => {
  const rows = [
    { ...row, featureSlug: "tokens", match: { model: "expensive" } },
    { ...row, featureSlug: "tokens", match: { model: "cheap" } },
  ]
  expect(featureRow(rows, "tokens")).toBeNull()
  expect(
    planVersionPrices(
      [{ featureType: "usage", feature: { slug: "tokens" } }],
      rows,
      "USD"
    ).displayPrices.get("tokens")
  ).toBe("2 prices by model")
  expect(
    describePlanFeatureLine(
      {
        featureType: "usage",
        feature: { title: "Tokens" },
        unitOfMeasure: "token",
        included: null,
        limit: null,
        defaultQuantity: 1,
        resetConfig: null,
      },
      { current: null, scheduled: null, byDimension: rows },
      "USD"
    )
  ).toBe("Tokens, priced per model")
})
