import {
  type RateRowInput,
  featurePricingSchema,
  rateCardSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import {
  CARD_FROM,
  creditsCard,
  enterpriseOverlay,
  features,
  includedApiCallsCard,
  priceChangeCard,
  usdCard,
  usdCardWithFallback,
} from "./fixtures"
import { validateCard } from "./validate"

const card = rateCardSchema.parse({
  id: "rc_bad",
  projectId: "proj_fixture",
  name: "Broken",
  unit: "money:USD",
  marginPolicy: { type: "manual" },
})

const unit = (...properties: (string | null)[]) => ({
  type: "unit" as const,
  components: properties.map((property) => ({ property, rate: "1", per: 1 })),
})

function row(fields: Partial<RateRowInput> & Pick<RateRowInput, "id" | "featureSlug" | "price">) {
  return rateRowSchema.parse({
    rateCardId: card.id,
    match: {},
    cost: null,
    effectiveFrom: CARD_FROM,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
    ...fields,
  })
}

describe("validateCard", () => {
  it("accepts every fixture card", () => {
    const usdFeatures = [
      features.llmTokens,
      features.images,
      features.apiCalls,
      features.emails,
      features.seats,
      features.baseFee,
    ]
    expect(validateCard(usdCard.card, usdCard.rows, usdFeatures)).toEqual([])
    expect(validateCard(usdCardWithFallback.card, usdCardWithFallback.rows, usdFeatures)).toEqual(
      []
    )
    expect(validateCard(creditsCard.card, creditsCard.rows, [features.llmTokens])).toEqual([])
    expect(
      validateCard(enterpriseOverlay.card, enterpriseOverlay.rows, [features.llmTokens])
    ).toEqual([])
    expect(validateCard(priceChangeCard.card, priceChangeCard.rows, [features.llmTokens])).toEqual(
      []
    )
    expect(
      validateCard(includedApiCallsCard.card, includedApiCallsCard.rows, [
        features.apiCallsIncluded,
      ])
    ).toEqual([])
  })

  it("returns every violation at once", () => {
    const tokens = featurePricingSchema.parse({
      slug: "llm_tokens",
      dimensions: ["model"],
      meterProperty: "input_tokens",
      included: "100",
    })
    const calls = featurePricingSchema.parse({
      slug: "api_calls",
      dimensions: [],
      meterProperty: "calls",
      included: "1000",
    })
    const rows = [
      row({
        id: "r1",
        featureSlug: "llm_tokens",
        match: { model: "gpt-4.1" },
        price: unit("input_tokens"),
      }),
      row({
        id: "r2",
        featureSlug: "llm_tokens",
        match: { model: "gpt-4.1" },
        price: unit("input_tokens"),
        effectiveFrom: CARD_FROM + 1,
      }),
      row({
        id: "r3",
        featureSlug: "llm_tokens",
        match: { model: "gpt-4.1", region: "eu" },
        price: unit("input_tokens"),
      }),
      row({
        id: "r4",
        featureSlug: "llm_tokens",
        price: {
          type: "graduated",
          property: "input_tokens",
          per: 1,
          tiers: [{ upTo: null, rate: "1", flat: "0" }],
        },
      }),
      row({
        id: "r5",
        featureSlug: "api_calls",
        price: unit("calls", "bytes"),
        effectiveTo: CARD_FROM + 100,
      }),
      row({
        id: "r6",
        featureSlug: "api_calls",
        price: {
          type: "graduated",
          property: "calls",
          per: 1,
          tiers: [
            { upTo: 100, rate: "1", flat: "0" },
            { upTo: 50, rate: "1", flat: "0" },
            { upTo: null, rate: "1", flat: "0" },
          ],
        },
        cost: { components: [{ property: "bytes", rate: "1", per: 1 }] },
        effectiveFrom: CARD_FROM + 100,
        effectiveTo: CARD_FROM + 200,
      }),
      row({
        id: "r7",
        featureSlug: "api_calls",
        price: unit("calls"),
        cost: {
          components: [
            { property: "calls", rate: "1", per: 1 },
            { property: "calls", rate: "2", per: 1 },
          ],
        },
        effectiveFrom: CARD_FROM + 200,
      }),
      row({ id: "r8", featureSlug: "unknown", rateCardId: "rc_other", price: unit(null) }),
    ]

    expect(validateCard(card, rows, [tokens, calls])).toEqual([
      { code: "UNKNOWN_DIMENSION", rowId: "r3", key: "region" },
      { code: "TIERED_WITH_DIMENSIONS", rowId: "r4" },
      { code: "INCLUDED_NOT_SINGLE_QUANTITY", rowId: "r5" },
      { code: "TIERS_INVALID", rowId: "r6" },
      { code: "COST_ON_UNPRICED_PROPERTY", rowId: "r6", property: "bytes" },
      { code: "DUPLICATE_PROPERTY", rowId: "r7", property: "calls" },
      { code: "ROW_OF_OTHER_CARD", rowId: "r8" },
      { code: "UNKNOWN_FEATURE", rowId: "r8", feature: "unknown" },
      { code: "INCLUDED_WITH_DIMENSIONS", feature: "llm_tokens" },
      { code: "MIXED_MATCH_KEYS", feature: "llm_tokens", keySets: ["model", "model,region"] },
      { code: "OVERLAPPING_ROWS", feature: "llm_tokens", rowIds: ["r1", "r2"] },
    ])
  })

  it("rejects package rows on a feature with dimensions and a bounded last tier", () => {
    const rows = [
      row({
        id: "pkg",
        featureSlug: "images",
        match: { size: "1024" },
        price: { type: "package", property: null, size: 10, rate: "1" },
      }),
      row({
        id: "bounded",
        featureSlug: "seats",
        price: {
          type: "graduated",
          property: "seats",
          per: 1,
          tiers: [{ upTo: 10, rate: "1", flat: "0" }],
        },
      }),
    ]
    expect(validateCard(card, rows, [features.images, features.seats])).toEqual([
      { code: "TIERED_WITH_DIMENSIONS", rowId: "pkg" },
      { code: "TIERS_INVALID", rowId: "bounded" },
    ])
  })

  it("rejects a cost on a property the row does not price", () => {
    const rows = [
      row({
        id: "flat",
        featureSlug: "base_fee",
        price: { type: "flat", amount: "49" },
        cost: { components: [{ property: null, rate: "1", per: 1 }] },
      }),
    ]
    expect(validateCard(card, rows, [features.baseFee])).toEqual([
      { code: "COST_ON_UNPRICED_PROPERTY", rowId: "flat", property: null },
    ])
  })

  it("allows adjacent rows of one match and a default beside exact rows", () => {
    const rows = [
      row({
        id: "a",
        featureSlug: "llm_tokens",
        match: { model: "m" },
        price: unit("input_tokens"),
        effectiveTo: CARD_FROM + 10,
      }),
      row({
        id: "b",
        featureSlug: "llm_tokens",
        match: { model: "m" },
        price: unit("input_tokens"),
        effectiveFrom: CARD_FROM + 10,
      }),
      row({ id: "c", featureSlug: "llm_tokens", price: unit("input_tokens") }),
    ]
    expect(validateCard(card, rows, [features.llmTokens])).toEqual([])
  })

  it("allows a feature's match keys to change where one set of rows ends and the next starts", () => {
    const regional = { ...features.llmTokens, dimensions: ["model", "region"] }
    const rows = [
      row({
        id: "global",
        featureSlug: "llm_tokens",
        match: { model: "m" },
        price: unit("input_tokens"),
        effectiveTo: CARD_FROM + 10,
      }),
      row({
        id: "regional",
        featureSlug: "llm_tokens",
        match: { model: "m", region: "eu" },
        price: unit("input_tokens"),
        effectiveFrom: CARD_FROM + 10,
      }),
    ]
    const overlapping = rows.map((r) => ({ ...r, effectiveTo: null }))

    expect(validateCard(card, rows, [regional])).toEqual([])
    expect(validateCard(card, overlapping, [regional])).toEqual([
      { code: "MIXED_MATCH_KEYS", feature: "llm_tokens", keySets: ["model", "model,region"] },
    ])
  })

  it("mixes key sets only where their rows overlap, not across a gap", () => {
    const regional = { ...features.llmTokens, dimensions: ["model", "region"] }
    const tokens = (id: string, match: Record<string, string>, from: number, to: number | null) =>
      row({
        id,
        featureSlug: "llm_tokens",
        match,
        price: unit("input_tokens"),
        effectiveFrom: CARD_FROM + from,
        effectiveTo: to === null ? null : CARD_FROM + to,
      })
    // A regroup to {model, region} at 10 and its reversal at 20.
    const reversed = [
      tokens("global", { model: "a" }, 0, 10),
      tokens("regional", { model: "a", region: "eu" }, 10, 20),
      tokens("global_again", { model: "a" }, 20, null),
    ]
    const overlapping = [...reversed, tokens("late", { model: "b", region: "us" }, 25, 30)]

    expect(validateCard(card, reversed, [regional])).toEqual([])
    expect(validateCard(card, overlapping, [regional])).toEqual([
      { code: "MIXED_MATCH_KEYS", feature: "llm_tokens", keySets: ["model", "model,region"] },
    ])
  })
})
