/**
 * The pricing core's data model: cards with their rows, positions, priced lines, and rejections.
 * The card, row, cost, and feature shapes are the Zod contracts in `@unprice/db/validators`.
 */

import type { FeaturePricing, RateCard, RateRow } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"
import type { Amount } from "@unprice/money"

export type CardRows = Readonly<{ card: RateCard; rows: readonly RateRow[] }>

/** The cards one subscription prices with. Overlay rows beat base rows of the same specificity. */
export type RateCards = Readonly<{ base: CardRows; overlay?: CardRows }>

/** The property name of a position that counts one unit per event. */
export const EVENT_POSITION = "#event"

/** Canonical form of a row's match: keys sorted, JSON, and "" for the default row. */
export function matchKey(match: Readonly<Record<string, string>>): string {
  const keys = Object.keys(match).sort()
  if (keys.length === 0) return ""
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, match[key]])))
}

/**
 * A position is the cumulative quantity one price component has accumulated in a statement
 * period. Feature slugs never contain "|" (the validators enforce it), so keys cannot collide.
 */
export function positionKey(feature: string, rowMatchKey: string, property: string | null) {
  return `${feature}|${rowMatchKey}|${property ?? EVENT_POSITION}`
}

export type PricedLine = Readonly<{
  positionKey: string
  property: string | null
  /** Cumulative quantity at scale 8, before and after this usage. */
  before: Amount
  after: Amount
  amount: Amount
  /** USD; null when the row carries no cost. */
  cost: Amount | null
}>

export type PricedUsage = Readonly<{
  cardId: string
  rowId: string
  lines: readonly PricedLine[]
  amount: Amount
  cost: Amount | null
  /** The quantity limits count for this usage, at scale 8. */
  meterQuantity: Amount
}>

export type PriceUsageInput = Readonly<{
  cards: RateCards
  feature: FeaturePricing
  properties: Readonly<Record<string, unknown>>
  at: number
  /** The current cumulative quantity of a position; 0 when it has none. */
  positionOf: (positionKey: string) => Amount
}>

export type PricingRejection =
  | Readonly<{ code: "INVALID_USAGE"; property: string; reason: string }>
  | Readonly<{ code: "NOT_PRICED"; feature: string; match: Readonly<Record<string, string>> }>

export type PricingErrorCode = PricingRejection["code"]

/** An expected pricing failure; `rejection` is plain data so it can cross an RPC boundary. */
export class UnPricePricingError extends BaseError<{ code: PricingErrorCode }> {
  public readonly retry = false
  public readonly name = "UnPricePricingError"
  public readonly code: PricingErrorCode

  constructor(public readonly rejection: PricingRejection) {
    super({ message: rejectionMessage(rejection), context: { code: rejection.code } })
    this.code = rejection.code
  }
}

function rejectionMessage(rejection: PricingRejection): string {
  switch (rejection.code) {
    case "INVALID_USAGE":
      return `Property ${rejection.property} is not a usable quantity: ${rejection.reason}`
    case "NOT_PRICED":
      return `No rate prices ${rejection.feature} for ${JSON.stringify(rejection.match)}`
  }
}

/** Everything `validateCard` rejects. A card is valid when the list is empty. */
export type CardViolation = Readonly<
  | { code: "ROW_OF_OTHER_CARD"; rowId: string }
  | { code: "UNKNOWN_FEATURE"; rowId: string; feature: string }
  | { code: "OVERLAPPING_ROWS"; feature: string; rowIds: readonly [string, string] }
  | { code: "MIXED_MATCH_KEYS"; feature: string; keySets: readonly string[] }
  | { code: "UNKNOWN_DIMENSION"; rowId: string; key: string }
  | { code: "TIERED_WITH_DIMENSIONS"; rowId: string }
  | { code: "INCLUDED_WITH_DIMENSIONS"; feature: string }
  | { code: "INCLUDED_NOT_SINGLE_QUANTITY"; rowId: string }
  | { code: "TIERS_INVALID"; rowId: string }
  | { code: "DUPLICATE_PROPERTY"; rowId: string; property: string | null }
  | { code: "COST_ON_UNPRICED_PROPERTY"; rowId: string; property: string | null }
>
