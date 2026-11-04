import { type FeaturePricing, type RateRow, rateRowSchema } from "@unprice/db/validators"
import { AMOUNT_ONE, type Amount, formatAmount } from "@unprice/money"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  CARD_FROM,
  creditsCard,
  enterpriseOverlay,
  features,
  includedApiCallsCard,
  priceEvents,
  usdCard,
  usdCardWithFallback,
} from "./fixtures"
import type { CardRows, PricedUsage, RateCards } from "./model"
import { estimateUsage, priceUsage } from "./rate"

const runs = Number.parseInt(process.env.UNPRICE_MODEL_RUNS ?? "300", 10)
const seed = process.env.UNPRICE_MODEL_SEED
  ? Number.parseInt(process.env.UNPRICE_MODEL_SEED, 10)
  : undefined

const ZERO = BigInt(0)
const at = CARD_FROM + 60 * 60 * 1000

type Scenario = Readonly<{
  name: string
  cards: RateCards
  feature: FeaturePricing
  /** Fixed properties (dimensions) of every event. */
  fixed: Readonly<Record<string, string>>
  /** Quantity properties and the largest whole-unit total each one draws. */
  quantities: Readonly<Record<string, number>>
}>

const tokens = { input_tokens: 2_000_000, cached_input_tokens: 500_000, output_tokens: 200_000 }

const flatIntoCheaperTier: CardRows = {
  card: { ...usdCard.card, id: "rc_flat_into_cheaper" },
  rows: [
    rateRowSchema.parse({
      id: "row_calls_flat_into_cheaper",
      rateCardId: "rc_flat_into_cheaper",
      featureSlug: "api_calls",
      match: {},
      price: {
        type: "graduated",
        property: "calls",
        per: 1,
        tiers: [
          { upTo: 100, rate: "1", flat: "0" },
          { upTo: null, rate: "0.1", flat: "10" },
        ],
      },
      cost: null,
      effectiveFrom: CARD_FROM,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    }),
  ],
}

const scenarios: readonly Scenario[] = [
  {
    name: "gpt-4.1 tokens, USD",
    cards: { base: usdCard },
    feature: features.llmTokens,
    fixed: { model: "gpt-4.1" },
    quantities: tokens,
  },
  {
    name: "claude-sonnet-4 tokens with cache writes, USD",
    cards: { base: usdCard },
    feature: features.llmTokens,
    fixed: { model: "claude-sonnet-4" },
    quantities: { ...tokens, cache_write_tokens: 300_000 },
  },
  {
    name: "unknown model on the fallback row",
    cards: { base: usdCardWithFallback },
    feature: features.llmTokens,
    fixed: { model: "gpt-5" },
    quantities: tokens,
  },
  {
    name: "gpt-4.1-mini tokens, credits",
    cards: { base: creditsCard },
    feature: features.llmTokens,
    fixed: { model: "gpt-4.1-mini" },
    quantities: tokens,
  },
  {
    name: "gpt-4.1 tokens, enterprise overlay",
    cards: { base: usdCard, overlay: enterpriseOverlay },
    feature: features.llmTokens,
    fixed: { model: "gpt-4.1" },
    quantities: tokens,
  },
  {
    name: "graduated API calls",
    cards: { base: usdCard },
    feature: features.apiCalls,
    fixed: {},
    quantities: { calls: 60_000 },
  },
  {
    name: "API calls with 1,000 included",
    cards: { base: includedApiCallsCard },
    feature: features.apiCallsIncluded,
    fixed: {},
    quantities: { calls: 3_000 },
  },
  {
    // A flat to enter a cheaper tier: the costliest stretch straddles the boundary.
    name: "graduated calls with a flat into a cheaper tier",
    cards: { base: flatIntoCheaperTier },
    feature: features.apiCalls,
    fixed: {},
    quantities: { calls: 300 },
  },
  {
    name: "email packages",
    cards: { base: usdCard },
    feature: features.emails,
    fixed: {},
    quantities: { emails: 5_000 },
  },
]

/** A quantity at scale 8: often whole units, sometimes with a fraction that forces rounding. */
function quantityArb(maxUnits: number): fc.Arbitrary<Amount> {
  const max = BigInt(maxUnits)
  return fc.oneof(
    fc.bigInt({ min: ZERO, max }).map((units) => units * AMOUNT_ONE),
    fc.bigInt({ min: ZERO, max: max * AMOUNT_ONE })
  )
}

function eventArb(scenario: Scenario, scale: number): fc.Arbitrary<Record<string, Amount>> {
  const record: Record<string, fc.Arbitrary<Amount>> = {}
  for (const [property, max] of Object.entries(scenario.quantities)) {
    record[property] = quantityArb(Math.max(1, Math.floor(max / scale)))
  }
  return fc.record(record)
}

/** A warm-up event, then a total split into 1 to 20 parts. */
function splitArb(scenario: Scenario) {
  return fc.record({
    warmUp: eventArb(scenario, 2),
    parts: fc.array(eventArb(scenario, 10), { minLength: 1, maxLength: 20 }),
  })
}

function sum(parts: readonly Record<string, Amount>[]): Record<string, Amount> {
  const total: Record<string, Amount> = {}
  for (const part of parts) {
    for (const [property, quantity] of Object.entries(part)) {
      total[property] = (total[property] ?? ZERO) + quantity
    }
  }
  return total
}

function events(scenario: Scenario, quantities: readonly Record<string, Amount>[]) {
  return quantities.map((quantity) => {
    const properties: Record<string, string> = { ...scenario.fixed }
    for (const [property, value] of Object.entries(quantity))
      properties[property] = formatAmount(value)
    return { properties, at }
  })
}

function totals(priced: readonly PricedUsage[]) {
  return {
    amount: priced.reduce((total, usage) => total + usage.amount, ZERO),
    cost: priced.reduce((total, usage) => total + (usage.cost ?? ZERO), ZERO),
  }
}

function priceAll(scenario: Scenario, quantities: readonly Record<string, Amount>[]) {
  const result = priceEvents(scenario.cards, scenario.feature, events(scenario, quantities))
  if (result.error) throw result.error
  return result
}

describe("pricing properties", () => {
  for (const scenario of scenarios) {
    it(`one event costs what the same usage split into many costs: ${scenario.name}`, () => {
      fc.assert(
        fc.property(splitArb(scenario), ({ warmUp, parts }) => {
          const whole = priceAll(scenario, [warmUp, sum(parts)])
          const split = priceAll(scenario, [warmUp, ...parts])
          expect(totals(split.priced)).toEqual(totals(whole.priced))
          expect(split.positions).toEqual(whole.positions)
        }),
        { numRuns: runs, seed }
      )
    })
  }

  it("never prices a line below zero", () => {
    const arb = fc
      .constantFrom(...scenarios)
      .chain((scenario) =>
        fc.tuple(
          fc.constant(scenario),
          fc.array(eventArb(scenario, 4), { minLength: 1, maxLength: 20 })
        )
      )
    fc.assert(
      fc.property(arb, ([scenario, quantities]) => {
        for (const usage of priceAll(scenario, quantities).priced) {
          for (const line of usage.lines) {
            expect(line.amount >= ZERO).toBe(true)
            expect((line.cost ?? ZERO) >= ZERO).toBe(true)
          }
        }
      }),
      { numRuns: runs, seed }
    )
  })

  it("prices included units from several grants as one allowance of their sum, in any order", () => {
    const grantArb = fc.array(fc.bigInt({ min: ZERO, max: BigInt(800) }), {
      minLength: 1,
      maxLength: 5,
    })
    const arb = fc.record({
      grants: grantArb,
      order: fc.array(fc.nat(), { minLength: 5, maxLength: 5 }),
      calls: fc.array(quantityArb(600), { minLength: 1, maxLength: 20 }),
    })
    fc.assert(
      fc.property(arb, ({ grants, order, calls }) => {
        const shuffled = grants
          .map((grant, index) => ({ grant, key: order[index] ?? 0 }))
          .sort((a, b) => a.key - b.key)
          .map(({ grant }) => grant)
        const priceWith = (allowance: readonly bigint[]) => {
          const included = allowance.reduce((total, grant) => total + grant * AMOUNT_ONE, ZERO)
          const feature = { ...features.apiCallsIncluded, included }
          const result = priceEvents(
            { base: includedApiCallsCard },
            feature,
            calls.map((quantity) => ({ properties: { calls: formatAmount(quantity) }, at }))
          )
          if (result.error) throw result.error
          return totals(result.priced).amount
        }
        const total = calls.reduce((a, b) => a + b, ZERO)
        const included = grants.reduce((a, b) => a + b, ZERO) * AMOUNT_ONE
        const billable = total > included ? total - included : ZERO
        // 0.002 per call: the exact price is billable * 0.002, rounded half up once.
        const expected = (billable * BigInt(2) + BigInt(500)) / BigInt(1000)
        expect(priceWith(grants)).toBe(expected)
        expect(priceWith(shuffled)).toBe(expected)
      }),
      { numRuns: runs, seed }
    )
  })

  it("never changes the price of a model the overlay has no row for", () => {
    const models = ["gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4"] as const
    const rateArb = fc
      .bigInt({ min: ZERO, max: BigInt(5000) })
      .map((cents) => formatAmount(cents * BigInt(1_000_000)))
    const arb = fc.record({
      overlayModels: fc.subarray([...models]),
      rates: fc.array(rateArb, { minLength: 3, maxLength: 3 }),
      model: fc.constantFrom(...models),
      quantities: fc.array(eventArb(scenarios[0] as Scenario, 4), { minLength: 1, maxLength: 10 }),
    })
    fc.assert(
      fc.property(arb, ({ overlayModels, rates, model, quantities }) => {
        fc.pre(!overlayModels.includes(model))
        const overlay: CardRows = {
          card: { ...enterpriseOverlay.card, id: "rc_random_overlay" },
          rows: overlayModels.map((overlayModel, index) =>
            overlayRow(overlayModel, rates[index] ?? "1")
          ),
        }
        const scenario = { ...(scenarios[0] as Scenario), fixed: { model } }
        const based = priceAll(scenario, quantities)
        const overlaid = priceAll({ ...scenario, cards: { base: usdCard, overlay } }, quantities)
        expect(overlaid.priced).toEqual(based.priced)
      }),
      { numRuns: runs, seed }
    )
  })

  it("sums an event stream's deltas to the rounded price of its total", () => {
    const thirds = rateRowSchema.parse({
      id: "row_thirds",
      rateCardId: "rc_thirds",
      featureSlug: "thirds",
      match: {},
      price: { type: "unit", components: [{ property: "units", rate: "1", per: 3 }] },
      cost: { components: [{ property: "units", rate: "0.7", per: 7 }] },
      effectiveFrom: CARD_FROM,
      effectiveTo: null,
      source: "manual",
      sourceRef: null,
    })
    const scenario: Scenario = {
      name: "thirds",
      cards: { base: { card: { ...usdCard.card, id: "rc_thirds" }, rows: [thirds] } },
      feature: { slug: "thirds", dimensions: [], meterProperty: "units", included: null },
      fixed: {},
      quantities: { units: 1_000 },
    }
    fc.assert(
      fc.property(
        fc.array(eventArb(scenario, 5), { minLength: 1, maxLength: 20 }),
        (quantities) => {
          const total = sum(quantities).units ?? ZERO
          // Price 1/3 per unit and cost 0.1 per unit, each rounded half up once at scale 8.
          const expected = {
            amount: (total * BigInt(2) + BigInt(3)) / BigInt(6),
            cost: total / BigInt(10) + (total % BigInt(10) >= BigInt(5) ? BigInt(1) : ZERO),
          }
          expect(totals(priceAll(scenario, quantities).priced)).toEqual(expected)
        }
      ),
      { numRuns: runs, seed }
    )
  })
  it("an estimate bounds the same or less usage priced from any position", () => {
    const arb = fc.constantFrom(...scenarios).chain((scenario) =>
      fc.record({
        scenario: fc.constant(scenario),
        warmUp: eventArb(scenario, 1),
        estimate: eventArb(scenario, 4),
        // Each actual quantity as a share of its estimate, in percent.
        shares: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 5 }),
      })
    )
    fc.assert(
      fc.property(arb, ({ scenario, warmUp, estimate, shares }) => {
        const { positions } = priceAll(scenario, [warmUp])
        const actual = Object.fromEntries(
          Object.entries(estimate).map(([property, quantity], index) => [
            property,
            (quantity * BigInt(shares[index] ?? 100)) / BigInt(100),
          ])
        )
        const [estimated] = events(scenario, [estimate])
        const [used] = events(scenario, [actual])
        if (!estimated || !used) throw new Error("no event")
        const input = { cards: scenario.cards, feature: scenario.feature, at }
        const bound = estimateUsage({ ...input, ...estimated, positionOf: () => ZERO })
        const priced = priceUsage({
          ...input,
          ...used,
          positionOf: (key) => positions.get(key) ?? ZERO,
        })
        if (bound.err || priced.err) throw bound.err ?? priced.err
        expect(priced.val.amount <= bound.val.amount).toBe(true)
        expect((priced.val.cost ?? ZERO) <= (bound.val.cost ?? ZERO)).toBe(true)
      }),
      { numRuns: runs, seed }
    )
  })
})

function overlayRow(model: string, outputRate: string): RateRow {
  return rateRowSchema.parse({
    id: `row_overlay_${model}`,
    rateCardId: "rc_random_overlay",
    featureSlug: "llm_tokens",
    match: { model },
    price: {
      type: "unit",
      components: [
        { property: "input_tokens", rate: "0.01", per: 1_000_000 },
        { property: "output_tokens", rate: outputRate, per: 1_000_000 },
      ],
    },
    cost: null,
    effectiveFrom: CARD_FROM,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
}
