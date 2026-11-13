import { type FeaturePricing, featurePricingSchema, rateRowSchema } from "@unprice/db/validators"
import { formatAmount, parseAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  CARD_FROM,
  PRICE_CHANGE_AT,
  creditsCard,
  enterpriseOverlay,
  features,
  includedApiCallsCard,
  priceChangeCard,
  priceEvents,
  usdCard,
  usdCardWithFallback,
} from "./fixtures"
import type { CardRows, PricedUsage, RateCards } from "./model"
import { estimateUsage, priceQuantity, priceUsage, quantityOf } from "./rate"

const at = CARD_FROM + 60 * 60 * 1000

function price(
  cards: RateCards,
  feature: FeaturePricing,
  events: readonly Record<string, unknown>[],
  when = at
) {
  return priceEvents(
    cards,
    feature,
    events.map((properties) => ({ properties, at: when }))
  )
}

function amounts(priced: readonly PricedUsage[]): string[] {
  return priced.map((usage) => formatAmount(usage.amount))
}

function amountOf(text: string): bigint {
  const parsed = parseAmount(text)
  if (!parsed.ok) throw new Error(text)
  return parsed.amount
}

function rowOf(card: CardRows, id: string) {
  const row = card.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(id)
  return row
}

describe("priceUsage: AI tokens", () => {
  it("prices each token component on its own position, with cost beside price", () => {
    const { priced } = price({ base: usdCard }, features.llmTokens, [
      {
        model: "gpt-4.1",
        input_tokens: 1_000_000,
        cached_input_tokens: 200_000,
        output_tokens: 50_000,
      },
    ])

    const [usage] = priced
    expect(usage?.cardId).toBe("rc_usd")
    expect(usage?.rowId).toBe("row_gpt41")
    expect(formatAmount(usage?.amount ?? BigInt(-1))).toBe("2.5")
    expect(formatAmount(usage?.cost ?? BigInt(-1))).toBe("2")
    expect(formatAmount(usage?.meterQuantity ?? BigInt(-1))).toBe("1")
    expect(
      usage?.lines.map((line) => [
        line.positionKey,
        formatAmount(line.before),
        formatAmount(line.after),
        formatAmount(line.amount),
        line.cost === null ? null : formatAmount(line.cost),
      ])
    ).toEqual([
      [
        String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","input_tokens"]`,
        "0",
        "1000000",
        "2",
        "1.6",
      ],
      [
        String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","cached_input_tokens"]`,
        "0",
        "200000",
        "0.1",
        "0.08",
      ],
      [
        String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","output_tokens"]`,
        "0",
        "50000",
        "0.4",
        "0.32",
      ],
    ])
  })

  it("prices one gpt-4.1-mini token at sub-cent precision", () => {
    const { priced } = price({ base: usdCard }, features.llmTokens, [
      { model: "gpt-4.1-mini", input_tokens: 1 },
    ])
    expect(amounts(priced)).toEqual(["0.0000004"])
  })

  it("prices claude-sonnet-4 cache writes as a fourth component", () => {
    const { priced } = price({ base: usdCard }, features.llmTokens, [
      {
        model: "claude-sonnet-4",
        input_tokens: 10_000,
        cached_input_tokens: 100_000,
        output_tokens: 2_000,
        cache_write_tokens: 20_000,
      },
    ])
    expect(amounts(priced)).toEqual(["0.165"])
    expect(formatAmount(priced[0]?.cost ?? BigInt(-1))).toBe("0.132")
  })

  it("denies an unknown model when the card has no default row", () => {
    const { priced, error } = price({ base: usdCard }, features.llmTokens, [
      { model: "gpt-5", input_tokens: 10 },
    ])
    expect(priced).toEqual([])
    expect(error?.rejection).toEqual({
      code: "NOT_PRICED",
      feature: "llm_tokens",
      match: { model: "gpt-5" },
    })
  })

  it("prices an unknown model at the default row, on the default position", () => {
    const { priced } = price({ base: usdCardWithFallback }, features.llmTokens, [
      { model: "gpt-5", output_tokens: 1_000_000 },
    ])
    expect(priced[0]?.rowId).toBe("row_tokens_default")
    expect(amounts(priced)).toEqual(["80"])
    expect(priced[0]?.lines[2]?.positionKey).toBe('["llm_tokens","","output_tokens"]')
  })

  it("prices a credits card in credits and keeps cost in USD", () => {
    const { priced } = price({ base: creditsCard }, features.llmTokens, [
      { model: "gpt-4.1", input_tokens: 1_000_000 },
      { model: "claude-sonnet-4", cache_write_tokens: 1_000_000 },
    ])
    expect(amounts(priced)).toEqual(["200", "375"])
    expect(priced.map((usage) => formatAmount(usage.cost ?? BigInt(-1)))).toEqual(["1.6", "3"])
  })

  it("prices gpt-4.1 from the enterprise overlay and claude from the base card", () => {
    const { priced } = price({ base: usdCard, overlay: enterpriseOverlay }, features.llmTokens, [
      { model: "gpt-4.1", output_tokens: 1_000_000 },
      { model: "claude-sonnet-4", output_tokens: 1_000_000 },
    ])
    expect(priced.map((usage) => [usage.cardId, usage.rowId])).toEqual([
      ["rc_enterprise", "row_enterprise_gpt41"],
      ["rc_usd", "row_claude_sonnet_4"],
    ])
    expect(amounts(priced)).toEqual(["6.4", "15"])
    expect(priced[0]?.lines[2]?.positionKey).toBe(
      String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","output_tokens"]`
    )
  })

  it("prices a mid-period price change on the same positions", () => {
    const cards = { base: priceChangeCard }
    const event = { model: "gpt-4.1", output_tokens: 1_000_000 }
    const before = priceEvents(cards, features.llmTokens, [
      { properties: event, at: PRICE_CHANGE_AT - 1 },
    ])
    const after = priceEvents(
      cards,
      features.llmTokens,
      [{ properties: event, at: PRICE_CHANGE_AT }],
      before.positions
    )

    expect(amounts(before.priced)).toEqual(["8"])
    expect(amounts(after.priced)).toEqual(["6"])
    expect(after.priced[0]?.rowId).toBe("row_gpt41_v2")
    const output = after.priced[0]?.lines[2]
    expect([
      formatAmount(output?.before ?? BigInt(-1)),
      formatAmount(output?.after ?? BigInt(-1)),
    ]).toEqual(["1000000", "2000000"])
  })
})

describe("priceUsage: images, API calls, emails", () => {
  it("prices images per event by size", () => {
    const { priced } = price({ base: usdCard }, features.images, [
      { size: 1024 },
      { size: "512" },
      { size: "512" },
    ])
    expect(amounts(priced)).toEqual(["0.04", "0.018", "0.018"])
    expect(priced[0]?.lines[0]?.positionKey).toBe(String.raw`["images","{\"size\":\"1024\"}",null]`)
    expect(formatAmount(priced[1]?.cost ?? BigInt(-1))).toBe("0.0144")
  })

  it("keys a per-event position apart from a property named #event", () => {
    // Built past the schema, which refuses names starting with #: the key alone keeps them apart.
    const image = rowOf(usdCard, "row_image_1024")
    const twoPositions: CardRows = {
      card: usdCard.card,
      rows: [
        {
          ...image,
          price: {
            type: "unit",
            components: [
              { property: null, rate: BigInt(100_000_000), per: 1 },
              { property: "#event", rate: BigInt(100_000_000), per: 1 },
            ],
          },
          cost: null,
        },
      ],
    }
    const { priced } = price({ base: twoPositions }, features.images, [
      { size: "1024", "#event": 3 },
    ])

    expect(priced[0]?.lines.map((line) => [line.positionKey, formatAmount(line.after)])).toEqual([
      [String.raw`["images","{\"size\":\"1024\"}",null]`, "1"],
      [String.raw`["images","{\"size\":\"1024\"}","#event"]`, "3"],
    ])
  })

  it("denies an image size the card does not price", () => {
    const { error } = price({ base: usdCard }, features.images, [{ size: 256 }])
    expect(error?.rejection).toEqual({
      code: "NOT_PRICED",
      feature: "images",
      match: { size: "256" },
    })
  })

  it("prices graduated API calls across tiers, with the flat on entering tier 2", () => {
    const { priced } = price({ base: usdCard }, features.apiCalls, [
      { calls: 10_000 },
      { calls: 1 },
      { calls: 89_999 },
      { calls: 50_000 },
    ])
    expect(amounts(priced)).toEqual(["0", "5.001", "89.999", "25"])
    expect(priced[0]?.cost).toBe(null)
    expect(
      amounts(price({ base: usdCard }, features.apiCalls, [{ calls: 150_000 }]).priced)
    ).toEqual(["120"])
  })

  it("takes included calls off before pricing, and charges cost on every call", () => {
    const { priced } = price({ base: includedApiCallsCard }, features.apiCallsIncluded, [
      { calls: 800 },
      { calls: 800 },
    ])
    expect(amounts(priced)).toEqual(["0", "1.2"])
    expect(priced.map((usage) => formatAmount(usage.cost ?? BigInt(-1)))).toEqual(["0.4", "0.4"])
    expect(priced.map((usage) => formatAmount(usage.meterQuantity))).toEqual(["800", "800"])
  })

  it("charges a started email package in full", () => {
    const { priced } = price({ base: usdCard }, features.emails, [
      { emails: 0.5 },
      { emails: 999.5 },
      { emails: 1 },
      { emails: 2_500 },
    ])
    expect(amounts(priced)).toEqual(["1", "0", "1", "2"])
    expect(formatAmount(priced[2]?.cost ?? BigInt(-1))).toBe("0.0001")
  })

  it("prices a per-event graduated row one unit per event", () => {
    const row = rateRowSchema.parse({
      id: "row_requests",
      rateCardId: "rc_requests",
      featureSlug: "requests",
      match: {},
      price: {
        type: "graduated",
        property: null,
        per: 1,
        tiers: [
          { upTo: 2, rate: "0", flat: "0" },
          { upTo: null, rate: "1", flat: "0.5" },
        ],
      },
      cost: null,
      effectiveFrom: CARD_FROM,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    })
    const card = { card: { ...usdCard.card, id: "rc_requests" }, rows: [row] }
    const requests = { slug: "requests", dimensions: [], meterProperty: null, included: null }
    const { priced } = price({ base: card }, requests, [{}, {}, {}, {}])
    expect(amounts(priced)).toEqual(["0", "0", "1.5", "1"])
  })
})

describe("priceUsage: rounding, validation, purity", () => {
  const thirds = rateRowSchema.parse({
    id: "row_thirds",
    rateCardId: "rc_thirds",
    featureSlug: "thirds",
    match: {},
    price: { type: "unit", components: [{ property: "units", rate: "1", per: 3 }] },
    cost: null,
    effectiveFrom: CARD_FROM,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
  const thirdsCards = { base: { card: { ...usdCard.card, id: "rc_thirds" }, rows: [thirds] } }
  const thirdsFeature = { slug: "thirds", dimensions: [], meterProperty: "units", included: null }

  it("rounds the cumulative price once, so the deltas sum to the rounded total", () => {
    const { priced } = price(thirdsCards, thirdsFeature, [{ units: 1 }, { units: 1 }, { units: 1 }])
    expect(amounts(priced)).toEqual(["0.33333333", "0.33333334", "0.33333333"])
  })

  it("names the property of an unusable quantity", () => {
    for (const value of [-1, "abc", Number.NaN, Number.POSITIVE_INFINITY, "0.123456789"]) {
      const { error } = price({ base: usdCard }, features.llmTokens, [
        { model: "gpt-4.1", input_tokens: 10, output_tokens: value },
      ])
      expect(error?.rejection).toMatchObject({ code: "INVALID_USAGE", property: "output_tokens" })
    }
    const meter = price({ base: usdCard }, features.emails, [{ emails: "-3" }])
    expect(meter.error?.rejection).toEqual({
      code: "INVALID_USAGE",
      property: "emails",
      reason: "negative",
    })
  })

  it("reads positions without advancing them", () => {
    const positions = new Map([
      [String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","input_tokens"]`, amountOf("10")],
    ])
    const input = {
      cards: { base: usdCard },
      feature: features.llmTokens,
      properties: { model: "gpt-4.1", input_tokens: 5 },
      at,
      positionOf: (key: string) => positions.get(key) ?? BigInt(0),
    }
    const first = priceUsage(input)
    const second = priceUsage(input)
    expect(second).toEqual(first)
    expect(formatAmount(first.val?.lines[0]?.after ?? BigInt(-1))).toBe("15")
    expect(
      formatAmount(
        positions.get(String.raw`["llm_tokens","{\"model\":\"gpt-4.1\"}","input_tokens"]`) ??
          BigInt(-1)
      )
    ).toBe("10")
  })
})

describe("priceQuantity", () => {
  it("prices seats on graduated tiers and the base fee flat", () => {
    const seats = rowOf(usdCard, "row_seats")
    const baseFee = rowOf(usdCard, "row_base_fee")
    expect(formatAmount(priceQuantity(seats, amountOf("7")))).toBe("66")
    expect(formatAmount(priceQuantity(seats, amountOf("5")))).toBe("50")
    expect(formatAmount(priceQuantity(seats, amountOf("0")))).toBe("0")
    expect(formatAmount(priceQuantity(baseFee, amountOf("3")))).toBe("49")
  })

  it("prices unit and package rows on the total quantity", () => {
    expect(formatAmount(priceQuantity(rowOf(usdCard, "row_emails"), amountOf("2500")))).toBe("3")
    expect(formatAmount(priceQuantity(rowOf(usdCard, "row_gpt41"), amountOf("1000000")))).toBe(
      "10.5"
    )
  })
})

describe("quantityOf", () => {
  it("reads only an event's own properties, so a missing `constructor` counts 0", () => {
    const toStringMeter = featurePricingSchema.parse({
      slug: "api_calls",
      dimensions: [],
      meterProperty: "toString",
      included: null,
    })
    const priced = priceUsage({
      cards: { base: includedApiCallsCard },
      feature: toStringMeter,
      properties: { calls: 10 },
      at,
      positionOf: () => BigInt(0),
    })

    expect(formatAmount(quantityOf({}, "constructor").val ?? BigInt(-1))).toBe("0")
    expect(formatAmount(quantityOf({ constructor: "2.5" }, "constructor").val ?? BigInt(-1))).toBe(
      "2.5"
    )
    expect(priced.err?.rejection).toBeUndefined()
    expect(priced.val && formatAmount(priced.val.amount)).toBe("0.02")
    expect(priced.val && formatAmount(priced.val.meterQuantity)).toBe("0")
  })
})

describe("estimateUsage: the most usage can cost from any position", () => {
  const estimate = (
    cards: RateCards,
    feature: FeaturePricing,
    properties: Record<string, unknown>
  ) => {
    const result = estimateUsage({ cards, feature, properties, at, positionOf: () => BigInt(0) })
    if (result.err) throw result.err
    return formatAmount(result.val.amount)
  }

  it("bounds graduated calls by the costliest stretch of tiers, flats included", () => {
    const calls = (n: number) => estimate({ base: usdCard }, features.apiCalls, { calls: n })
    // From 10,000: the $5 entry plus 1,500 x $0.001.
    expect(calls(1_500)).toBe("6.5")
    // From 10,000: $5 + 90,000 x $0.001 + 110,000 x $0.0005, more than from 0 ($145).
    expect(calls(200_000)).toBe("150")
    expect(calls(0)).toBe("0")
  })

  it("bounds a flat into a cheaper tier where usage straddles the boundary", () => {
    const card: CardRows = {
      card: { ...usdCard.card, id: "rc_flat_into_cheaper" },
      rows: [
        rateRowSchema.parse({
          ...rowOf(usdCard, "row_api_calls"),
          id: "row_flat_into_cheaper",
          rateCardId: "rc_flat_into_cheaper",
          price: {
            type: "graduated",
            property: "calls",
            per: 1,
            tiers: [
              { upTo: 100, rate: "1", flat: "0" },
              { upTo: null, rate: "0.1", flat: "10" },
            ],
          },
        }),
      ],
    }
    // From just past 50: almost 50 calls at $1, then the $10 flat, rounded up to $60.
    expect(estimate({ base: card }, features.apiCalls, { calls: 50 })).toBe("60")
  })

  it("prices and bounds a row at the 100-tier cap", () => {
    // Tier i (from 0) covers calls (10i, 10i + 10] at $1 each, with a $1 flat on entering it.
    const tiers = Array.from({ length: 100 }, (_, index) => ({
      upTo: index === 99 ? null : (index + 1) * 10,
      rate: "1",
      flat: "1",
    }))
    const card: CardRows = {
      card: { ...usdCard.card, id: "rc_many_tiers" },
      rows: [
        rateRowSchema.parse({
          ...rowOf(usdCard, "row_api_calls"),
          id: "row_many_tiers",
          rateCardId: "rc_many_tiers",
          price: { type: "graduated", property: "calls", per: 1, tiers },
        }),
      ],
    }
    const { priced } = price({ base: card }, features.apiCalls, [{ calls: 995 }, { calls: 10 }])

    // 995 calls enter all 100 tiers: $995 + $100 in flats. 10 more stay in the last tier.
    expect(amounts(priced)).toEqual(["1095", "10"])
    // From any position, 10 calls enter exactly one tier: $10 plus one $1 flat.
    expect(estimate({ base: card }, features.apiCalls, { calls: 10 })).toBe("11")
  })

  it("bounds packages by one package per started size, however the units straddle", () => {
    const emails = (n: number) => estimate({ base: usdCard }, features.emails, { emails: n })
    expect([emails(1), emails(1_000), emails(1_001), emails(2_500)]).toEqual(["1", "1", "2", "3"])
  })

  it("bounds included units at the full rate: any of them may be past the allowance", () => {
    const included = estimate({ base: includedApiCallsCard }, features.apiCallsIncluded, {
      calls: 1_000,
    })
    expect(included).toBe("2")
  })

  it("bounds unit prices by the exact price rounded up", () => {
    const mini = estimate({ base: usdCard }, features.llmTokens, {
      model: "gpt-4.1-mini",
      input_tokens: 1,
    })
    expect(mini).toBe("0.0000004")
  })

  it("refuses an allowance a row cannot take: one matching a dimension or pricing two quantities", () => {
    const twoQuantities: CardRows = {
      ...includedApiCallsCard,
      rows: includedApiCallsCard.rows.map((row) => ({
        ...row,
        price: {
          type: "unit" as const,
          components: [
            { property: "calls", rate: amountOf("0.002"), per: 1 },
            { property: null, rate: amountOf("0.001"), per: 1 },
          ],
        },
      })),
    }
    const result = priceUsage({
      cards: { base: twoQuantities },
      feature: features.apiCallsIncluded,
      properties: { calls: 500 },
      at,
      positionOf: () => BigInt(0),
    })
    expect(result.err?.rejection).toEqual({
      code: "INCLUDED_NOT_APPLICABLE",
      feature: "api_calls",
      rowId: "row_api_calls_included",
    })
  })
})
