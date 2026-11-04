/**
 * Metering (ADR-0008 D4, D6): an event becomes a usage vector, priced once on the positions of the
 * statement each of its features counts in. Pure; the statements come back with the event applied.
 */

import type { BudgetPricing } from "@unprice/db/validators"
import { Ok, type Result } from "@unprice/error"
import type { Amount } from "@unprice/money"
import { type CardRows, type RateCards, estimateUsage, priceUsage, quantityOf } from "../pricing"
import { canonicalJson } from "../rate-cards/wire"
import type { BudgetRecord } from "./config"
import {
  type BudgetEvent,
  type PricedEvent,
  type PricedFeature,
  type Statement,
  type StatementRegistration,
  type UnPriceBudgetError,
  reject,
} from "./model"
import { type Usage, usageOf } from "./usage"

const ZERO = BigInt(0)

/** The most an event's properties may take, serialized; the operation row keeps them. */
const MAX_EVENT_PROPERTIES_BYTES = 4096

/**
 * A budget whose pricing needs no statements keeps one perpetual statement per feature, never
 * sealed, so positions and totals live in the same row shape as a billing period's.
 */
export const PERPETUAL_STATEMENT_KEY = "#budget"
const PERPETUAL_STATEMENT_END = Number.MAX_SAFE_INTEGER

function perpetualPeriodId(featureSlug: string): string {
  return `${PERPETUAL_STATEMENT_KEY}:${featureSlug}`
}

export function isPerpetual(statement: Statement): boolean {
  return statement.statementKey === PERPETUAL_STATEMENT_KEY
}

export type Metered = Readonly<{
  usage: Usage
  priced: PricedEvent
  /** The statements a consumed event counts in, with it applied; none for an estimate. */
  statements: readonly Statement[]
}>

type MeterInput = Readonly<{
  budget: BudgetRecord
  cards: Readonly<Record<string, CardRows>>
  /** Open statements of the event's features and those covering `at`. */
  statements: readonly Statement[]
  event: BudgetEvent
  /** When the event prices and which statement it counts in. */
  at: number
  /** The clamped clock: when a perpetual statement is first written. */
  now: number
  /**
   * An estimate prices the most the event can cost from any position and moves nothing (a hold);
   * otherwise the event is consumed at the positions and moves them.
   */
  estimate: boolean
}>

/**
 * Prices every feature the event feeds, or rejects the whole event: a feature that cannot be
 * priced or routed leaves no partial write.
 */
export function meterEvent(input: MeterInput): Result<Metered, UnPriceBudgetError> {
  const { budget, event, at } = input
  const pricing = budget.config.pricing
  const features = pricing ? featuresOf(pricing, event.slug) : []
  if (!pricing || features.length === 0) return reject({ code: "UNKNOWN_EVENT", slug: event.slug })
  const size = new TextEncoder().encode(JSON.stringify(event.properties)).length
  if (size > MAX_EVENT_PROPERTIES_BYTES) {
    return reject({
      code: "INVALID_USAGE",
      property: "properties",
      reason: `${size} bytes serialized; at most ${MAX_EVENT_PROPERTIES_BYTES}`,
    })
  }

  let cards: RateCards | null = null
  if (features.some((feature) => feature.priced)) {
    const resolved = cardsOf(pricing, budget.unit, input.cards)
    if (resolved.err) return resolved
    cards = resolved.val
  }
  const price = input.estimate ? estimateUsage : priceUsage

  const priced: PricedFeature[] = []
  const statements: Statement[] = []
  let amount = ZERO
  const quantities: (readonly [string, Amount])[] = []
  for (const feature of features) {
    const routed = statementFor(pricing, feature.slug, input.statements, at, input.now)
    if (routed.err) return routed
    const { statement, late } = routed.val
    const route = { featureSlug: feature.slug, periodId: statement.periodId, late }
    let charged: PricedFeature
    if (!feature.priced || !cards) {
      const meterQuantity = quantityOf(event.properties, feature.meterProperty)
      if (meterQuantity.err) return reject(meterQuantity.err.rejection)
      const unpriced = { cardId: null, rowId: null, lines: [], amount: ZERO, cost: null }
      charged = { ...route, ...unpriced, meterQuantity: meterQuantity.val }
    } else {
      const { positions } = statement
      const result = price({
        cards,
        feature,
        properties: event.properties,
        at,
        positionOf: (key) => (Object.hasOwn(positions, key) ? (positions[key] as Amount) : ZERO),
      })
      if (result.err) return reject(result.err.rejection)
      const { cardId, rowId, lines, meterQuantity, amount, cost } = result.val
      charged = { ...route, cardId, rowId, lines, meterQuantity, amount, cost }
    }
    priced.push(charged)
    amount += charged.amount
    quantities.push([feature.slug, charged.meterQuantity])
    if (!input.estimate) statements.push(applied(statement, charged, at))
  }
  return Ok({
    usage: usageOf(amount, Object.fromEntries(quantities)),
    priced: { slug: event.slug, properties: event.properties, at, features: priced },
    statements,
  })
}

/** The metered features an event slug feeds. */
export function featuresOf(
  pricing: BudgetPricing,
  eventSlug: string
): BudgetPricing["features"][number][] {
  return pricing.features.filter((feature) => feature.eventSlug === eventSlug)
}

/** The ids of the cards the pricing names: the base, then the overlay; none when nothing is priced. */
export function cardIdsOf(pricing: BudgetPricing): string[] {
  if (pricing.cards === undefined) return []
  const { base, overlay } = pricing.cards
  return overlay === undefined ? [base] : [base, overlay]
}

/** The cards the pricing names, each cached and in the budget's unit. */
export function cardsOf(
  pricing: BudgetPricing,
  unit: string,
  cached: Readonly<Record<string, CardRows>>
): Result<RateCards, UnPriceBudgetError> {
  const cards: CardRows[] = []
  // The schema gives every priced feature its cards; a pricing without cards prices nothing.
  if (pricing.cards === undefined) throw new Error("a pricing without cards prices nothing")
  for (const cardId of cardIdsOf(pricing)) {
    // Card ids are caller data: `constructor` is a missing card, not Object's.
    const card = Object.hasOwn(cached, cardId) ? cached[cardId] : undefined
    if (!card) return reject({ code: "CARD_NOT_FOUND", cardId })
    if (card.card.unit !== unit) {
      return reject({ code: "UNIT_MISMATCH", cardId, unit, cardUnit: card.card.unit })
    }
    cards.push(card)
  }
  const [base, overlay] = cards as [CardRows, CardRows?]
  return Ok(overlay === undefined ? { base } : { base, overlay })
}

/**
 * ADR-0008 D6: the statement covering `at` when open; when it is sealed or completed, the earliest
 * open one of the feature that starts at or after its end, marked late, else PERIOD_CLOSED. No
 * statement covering `at` is NO_STATEMENT. Without required statements, the feature's perpetual
 * statement.
 */
function statementFor(
  pricing: BudgetPricing,
  featureSlug: string,
  statements: readonly Statement[],
  at: number,
  now: number
): Result<{ statement: Statement; late: boolean }, UnPriceBudgetError> {
  if (pricing.statements === "none") {
    const periodId = perpetualPeriodId(featureSlug)
    const statement = statements.find((s) => s.periodId === periodId)
    return Ok({ statement: statement ?? perpetualStatement(featureSlug, now), late: false })
  }
  const own = statements.filter((s) => s.featureSlug === featureSlug && !isPerpetual(s))
  const covering = own.find((s) => s.start <= at && at < s.end)
  if (!covering) return reject({ code: "NO_STATEMENT", featureSlug, at })
  if (covering.state === "open") return Ok({ statement: covering, late: false })
  const next = own
    .filter((s) => s.state === "open" && s.start >= covering.end)
    .sort((a, b) => a.start - b.start)[0]
  if (next) return Ok({ statement: next, late: true })
  return reject({ code: "PERIOD_CLOSED", featureSlug, at, periodId: covering.periodId })
}

function perpetualStatement(featureSlug: string, now: number): Statement {
  const periodId = perpetualPeriodId(featureSlug)
  const statementKey = PERPETUAL_STATEMENT_KEY
  return emptyStatement(
    { periodId, statementKey, featureSlug, start: 0, end: PERPETUAL_STATEMENT_END },
    now
  )
}

/** A registered statement before any usage: open, at zero. */
export function emptyStatement(
  registration: StatementRegistration,
  registeredAt: number
): Statement {
  return {
    ...registration,
    state: "open",
    registeredAt,
    sealedAt: null,
    completedAt: null,
    quantity: ZERO,
    amount: ZERO,
    cost: null,
    events: 0,
    lastEventAt: null,
    positions: {},
  }
}

function applied(statement: Statement, feature: PricedFeature, at: number): Statement {
  const positions: Record<string, Amount> = { ...statement.positions }
  for (const line of feature.lines) positions[line.positionKey] = line.after
  return {
    ...statement,
    quantity: statement.quantity + feature.meterQuantity,
    amount: statement.amount + feature.amount,
    cost: sumCosts([statement.cost, feature.cost]),
    events: statement.events + 1,
    lastEventAt: statement.lastEventAt === null ? at : Math.max(statement.lastEventAt, at),
    positions,
  }
}

/** USD costs summed; null until one is known, so uncosted lines never read as free. */
export function sumCosts(costs: readonly (Amount | null)[]): Amount | null {
  return costs.reduce<Amount | null>(
    (sum, cost) => (cost === null ? sum : (sum ?? ZERO) + cost),
    null
  )
}

/** Whether a retry repeats the event: the same slug and the same properties, key order aside. */
export function sameEvent(a: BudgetEvent, b: BudgetEvent): boolean {
  return a.slug === b.slug && canonicalJson(a.properties) === canonicalJson(b.properties)
}
