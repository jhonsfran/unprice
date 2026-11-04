import type { FeaturePricing, RateCard, RateRow } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { type CardRows, type RateCards, UnPricePricingError } from "./model"

export type ResolvedRow = Readonly<{ card: RateCard; row: RateRow }>

export function isEffective(row: RateRow, at: number): boolean {
  return row.effectiveFrom <= at && (row.effectiveTo === null || at < row.effectiveTo)
}

/**
 * The usage row for an event: overlay exact, base exact, overlay default, base default. A flat
 * row is recurring and never prices usage.
 */
export function resolveRow(
  cards: RateCards,
  feature: FeaturePricing,
  properties: Readonly<Record<string, unknown>>,
  at: number
): Result<ResolvedRow, UnPricePricingError> {
  const layers = cards.overlay ? [cards.overlay, cards.base] : [cards.base]
  for (const exact of [true, false]) {
    for (const layer of layers) {
      const row = findRow(layer, feature.slug, properties, at, exact)
      if (row) return Ok({ card: layer.card, row })
    }
  }
  const match: Record<string, string> = {}
  for (const dimension of feature.dimensions) {
    const value = properties[dimension]
    if (value !== undefined && value !== null) match[dimension] = String(value)
  }
  return Err(new UnPricePricingError({ code: "NOT_PRICED", feature: feature.slug, match }))
}

function findRow(
  layer: CardRows,
  feature: string,
  properties: Readonly<Record<string, unknown>>,
  at: number,
  exact: boolean
): RateRow | undefined {
  return layer.rows.find((row) => {
    if (row.featureSlug !== feature || row.price.type === "flat" || !isEffective(row, at)) {
      return false
    }
    const entries = Object.entries(row.match)
    if (exact !== entries.length > 0) return false
    return entries.every(([key, value]) => {
      const actual = properties[key]
      return actual !== undefined && actual !== null && String(actual) === value
    })
  })
}
