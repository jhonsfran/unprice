/**
 * Realistic rate cards for pricing and budget scenario tests. Written in wire form and parsed
 * through the `@unprice/db/validators` schemas, so every fixture is a valid contract.
 */

import {
  type FeaturePricing,
  type FeaturePricingInput,
  type ModelCost,
  type ModelCostInput,
  type RateCard,
  type RateCardInput,
  type RateRowInput,
  featurePricingSchema,
  modelCostSchema,
  rateCardSchema,
  rateRowSchema,
} from "@unprice/db/validators"
import type { Amount } from "@unprice/money"
import type { CostPlusCard } from "./cost-plus"
import type { CardRows, PricedUsage, RateCards, UnPricePricingError } from "./model"
import { priceUsage } from "./rate"

export const CARD_FROM = Date.parse("2026-11-01T00:00:00.000Z")
export const PRICE_CHANGE_AT = Date.parse("2026-11-15T00:00:00.000Z")

function feature(input: FeaturePricingInput): FeaturePricing {
  return featurePricingSchema.parse(input)
}

export const features = {
  llmTokens: feature({
    slug: "llm_tokens",
    dimensions: ["model"],
    meterProperty: null,
    included: null,
  }),
  images: feature({ slug: "images", dimensions: ["size"], meterProperty: null, included: null }),
  apiCalls: feature({ slug: "api_calls", dimensions: [], meterProperty: "calls", included: null }),
  apiCallsIncluded: feature({
    slug: "api_calls",
    dimensions: [],
    meterProperty: "calls",
    included: "1000",
  }),
  emails: feature({ slug: "emails", dimensions: [], meterProperty: "emails", included: null }),
  seats: feature({ slug: "seats", dimensions: [], meterProperty: "seats", included: null }),
  baseFee: feature({ slug: "base_fee", dimensions: [], meterProperty: null, included: null }),
} as const

type RowFields = Omit<
  RateRowInput,
  "rateCardId" | "effectiveFrom" | "effectiveTo" | "source" | "sourceRef"
> &
  Partial<Pick<RateRowInput, "effectiveFrom" | "effectiveTo" | "source" | "sourceRef">>

function cardRows(input: RateCardInput, rows: readonly RowFields[]): CardRows {
  const card = rateCardSchema.parse(input)
  return {
    card,
    rows: rows.map((fields) =>
      rateRowSchema.parse({
        effectiveFrom: CARD_FROM,
        effectiveTo: null,
        source: "manual",
        sourceRef: null,
        ...fields,
        rateCardId: card.id,
      })
    ),
  }
}

type TokenRates = Readonly<{
  input: string
  cached: string
  output: string
  cacheWrite?: string
}>

/** One row per model; rates are per million tokens. */
function tokenComponents(rates: TokenRates) {
  const components = [
    { property: "input_tokens", rate: rates.input, per: 1_000_000 },
    { property: "cached_input_tokens", rate: rates.cached, per: 1_000_000 },
    { property: "output_tokens", rate: rates.output, per: 1_000_000 },
  ]
  if (rates.cacheWrite) {
    components.push({ property: "cache_write_tokens", rate: rates.cacheWrite, per: 1_000_000 })
  }
  return components
}

/** A null model is the default row. */
function tokenRow(
  id: string,
  model: string | null,
  price: TokenRates,
  cost: TokenRates
): RowFields {
  return {
    id,
    featureSlug: "llm_tokens",
    match: model === null ? {} : { model },
    price: { type: "unit", components: tokenComponents(price) },
    cost: { components: tokenComponents(cost) },
  }
}

/** Costs are 80% of the USD list price. */
const usdTokenRows = [
  tokenRow(
    "row_gpt41",
    "gpt-4.1",
    { input: "2.00", cached: "0.50", output: "8.00" },
    { input: "1.60", cached: "0.40", output: "6.40" }
  ),
  tokenRow(
    "row_gpt41_mini",
    "gpt-4.1-mini",
    { input: "0.40", cached: "0.10", output: "1.60" },
    { input: "0.32", cached: "0.08", output: "1.28" }
  ),
  tokenRow(
    "row_claude_sonnet_4",
    "claude-sonnet-4",
    { input: "3.00", cached: "0.30", output: "15.00", cacheWrite: "3.75" },
    { input: "2.40", cached: "0.24", output: "12.00", cacheWrite: "3.00" }
  ),
]

const usdCardInput: RateCardInput = {
  id: "rc_usd",
  projectId: "proj_fixture",
  name: "Standard USD",
  unit: "money:USD",
  marginPolicy: { type: "manual" },
}

const usdRows: RowFields[] = [
  ...usdTokenRows,
  {
    id: "row_image_1024",
    featureSlug: "images",
    match: { size: "1024" },
    price: { type: "unit", components: [{ property: null, rate: "0.04", per: 1 }] },
    cost: { components: [{ property: null, rate: "0.032", per: 1 }] },
  },
  {
    id: "row_image_512",
    featureSlug: "images",
    match: { size: "512" },
    price: { type: "unit", components: [{ property: null, rate: "0.018", per: 1 }] },
    cost: { components: [{ property: null, rate: "0.0144", per: 1 }] },
  },
  {
    id: "row_api_calls",
    featureSlug: "api_calls",
    match: {},
    price: {
      type: "graduated",
      property: "calls",
      per: 1,
      tiers: [
        { upTo: 10_000, rate: "0", flat: "0" },
        { upTo: 100_000, rate: "0.001", flat: "5.00" },
        { upTo: null, rate: "0.0005", flat: "0" },
      ],
    },
    cost: null,
  },
  {
    id: "row_emails",
    featureSlug: "emails",
    match: {},
    price: { type: "package", property: "emails", size: 1_000, rate: "1.00" },
    cost: { components: [{ property: "emails", rate: "0.10", per: 1_000 }] },
  },
  {
    id: "row_seats",
    featureSlug: "seats",
    match: {},
    price: {
      type: "graduated",
      property: "seats",
      per: 1,
      tiers: [
        { upTo: 5, rate: "10.00", flat: "0" },
        { upTo: null, rate: "8.00", flat: "0" },
      ],
    },
    cost: null,
  },
  {
    id: "row_base_fee",
    featureSlug: "base_fee",
    match: {},
    price: { type: "flat", amount: "49.00" },
    cost: null,
  },
]

/** The USD card: tokens per model, images per size, graduated API calls, email packages, seats. */
export const usdCard: CardRows = cardRows(usdCardInput, usdRows)

/** A default token row priced high, so an unknown model still prices. */
export const usdCardWithFallback: CardRows = cardRows(usdCardInput, [
  ...usdRows,
  tokenRow(
    "row_tokens_default",
    null,
    { input: "20.00", cached: "5.00", output: "80.00" },
    { input: "16.00", cached: "4.00", output: "64.00" }
  ),
])

/** API calls with 1,000 included per period, then 0.002 per call. */
export const includedApiCallsCard: CardRows = cardRows(
  { ...usdCardInput, id: "rc_usd_included", name: "Included API calls" },
  [
    {
      id: "row_api_calls_included",
      featureSlug: "api_calls",
      match: {},
      price: { type: "unit", components: [{ property: "calls", rate: "0.002", per: 1 }] },
      cost: { components: [{ property: "calls", rate: "0.0005", per: 1 }] },
    },
  ]
)

/** The same token components priced in credits worth 0.01 USD; costs stay in USD. */
export const creditsCard: CardRows = cardRows(
  {
    id: "rc_credits",
    projectId: "proj_fixture",
    name: "AI credits",
    unit: "credits:ai",
    creditValueUsd: "0.01",
    marginPolicy: { type: "manual" },
  },
  [
    tokenRow(
      "row_credits_gpt41",
      "gpt-4.1",
      { input: "200", cached: "50", output: "800" },
      { input: "1.60", cached: "0.40", output: "6.40" }
    ),
    tokenRow(
      "row_credits_gpt41_mini",
      "gpt-4.1-mini",
      { input: "40", cached: "10", output: "160" },
      { input: "0.32", cached: "0.08", output: "1.28" }
    ),
    tokenRow(
      "row_credits_claude_sonnet_4",
      "claude-sonnet-4",
      { input: "300", cached: "30", output: "1500", cacheWrite: "375" },
      { input: "2.40", cached: "0.24", output: "12.00", cacheWrite: "3.00" }
    ),
  ]
)

/** An enterprise overlay: gpt-4.1 at 20% off; every other row comes from the base card. */
export const enterpriseOverlay: CardRows = cardRows(
  { ...usdCardInput, id: "rc_enterprise", name: "Acme enterprise" },
  [
    tokenRow(
      "row_enterprise_gpt41",
      "gpt-4.1",
      { input: "1.60", cached: "0.40", output: "6.40" },
      { input: "1.60", cached: "0.40", output: "6.40" }
    ),
  ]
)

/** gpt-4.1 output drops from 8.00 to 6.00 at PRICE_CHANGE_AT: the old row closes, a successor opens. */
export const priceChangeCard: CardRows = cardRows(
  { ...usdCardInput, id: "rc_price_change", name: "Price change" },
  [
    {
      ...tokenRow(
        "row_gpt41_v1",
        "gpt-4.1",
        { input: "2.00", cached: "0.50", output: "8.00" },
        { input: "1.60", cached: "0.40", output: "6.40" }
      ),
      effectiveTo: PRICE_CHANGE_AT,
    },
    {
      ...tokenRow(
        "row_gpt41_v2",
        "gpt-4.1",
        { input: "2.00", cached: "0.50", output: "6.00" },
        { input: "1.60", cached: "0.40", output: "4.80" }
      ),
      effectiveFrom: PRICE_CHANGE_AT,
    },
  ]
)

const llmTokensPolicy = {
  featureSlug: "llm_tokens",
  markup: "0.3",
  roundTo: "0.01",
  dimension: "model",
  componentMap: {
    input: "input_tokens",
    cache_read: "cached_input_tokens",
    output: "output_tokens",
    cache_write: "cache_write_tokens",
  },
} as const

const costPlusPolicy = { type: "costPlus" as const, features: [llmTokensPolicy] }

function costPlusCard(input: RateCardInput): CostPlusCard {
  const card: RateCard = rateCardSchema.parse(input)
  if (card.marginPolicy.type !== "costPlus") throw new Error("fixture is not cost-plus")
  return { ...card, marginPolicy: card.marginPolicy }
}

export const usdCostPlusCard = costPlusCard({
  ...usdCardInput,
  id: "rc_cost_plus",
  name: "Cost plus 30%",
  marginPolicy: costPlusPolicy,
})

export const creditsCostPlusCard = costPlusCard({
  id: "rc_credits_cost_plus",
  projectId: "proj_fixture",
  name: "Credits cost plus 30%",
  unit: "credits:ai",
  creditValueUsd: "0.01",
  marginPolicy: { type: "costPlus", features: [{ ...llmTokensPolicy, roundTo: "1" }] },
})

function modelCost(input: ModelCostInput): ModelCost {
  return modelCostSchema.parse(input)
}

/** models.dev-style costs, USD per million tokens. */
export const modelCosts = {
  gpt41: modelCost({
    provider: "openai",
    model: "gpt-4.1",
    components: { input: "2.00", cache_read: "0.50", output: "8.00" },
    effectiveFrom: CARD_FROM,
    source: "modelsdev",
    sourceRef: "snap_2026_11_01",
  }),
  claudeSonnet4: modelCost({
    provider: "anthropic",
    model: "claude-sonnet-4",
    components: { input: "3.00", cache_read: "0.30", output: "15.00", cache_write: "3.75" },
    effectiveFrom: CARD_FROM,
    source: "modelsdev",
    sourceRef: "snap_2026_11_01",
  }),
}

export type UsageEvent = Readonly<{ properties: Readonly<Record<string, unknown>>; at: number }>

/**
 * Prices events in order against one statement period's positions, the way a budget applies
 * them: each accepted event's `after` becomes the position the next event starts from.
 */
export function priceEvents(
  cards: RateCards,
  pricing: FeaturePricing,
  events: readonly UsageEvent[],
  positions: Map<string, Amount> = new Map()
): { priced: PricedUsage[]; positions: Map<string, Amount>; error?: UnPricePricingError } {
  const priced: PricedUsage[] = []
  for (const event of events) {
    const result = priceUsage({
      cards,
      feature: pricing,
      properties: event.properties,
      at: event.at,
      positionOf: (key) => positions.get(key) ?? BigInt(0),
    })
    if (result.err) return { priced, positions, error: result.err }
    for (const line of result.val.lines) positions.set(line.positionKey, line.after)
    priced.push(result.val)
  }
  return { priced, positions }
}
