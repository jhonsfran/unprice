import type { RateRow } from "@unprice/db/validators"

export {
  type FeaturePriceRows,
  rowsByFeature,
  scheduledFrom,
  describeFeaturePrice,
} from "@unprice/services/pricing"
import type { FeaturePriceRows } from "@unprice/services/pricing"

/** Whether publishing accepts a feature's rows: priced now, priced from a later start, or not at all. */
export type PriceState = "priced" | "scheduled" | "unpriced"

export function priceStateOf(entry: FeaturePriceRows | undefined): PriceState {
  if (!entry) return "unpriced"
  if (entry.current || entry.byDimension.length > 0) return "priced"
  return entry.scheduled ? "scheduled" : "unpriced"
}

/**
 * The `rateCards.forPlanVersion` cache after a feature save answered its default row: that row
 * replaces the feature's default row on the card in `currency` (and ends it when null); every
 * other row, including the feature's dimension rows, stays.
 */
export function withDefaultRow<T extends { currency: string; rows: RateRow[] }>(
  cards: readonly T[],
  currency: string,
  featureSlug: string,
  row: RateRow | null
): T[] {
  return cards.map((card) => {
    if (card.currency !== currency) return card
    const rows = card.rows.filter(
      (candidate) =>
        candidate.featureSlug !== featureSlug || Object.keys(candidate.match).length > 0
    )
    return { ...card, rows: row ? [...rows, row] : rows }
  })
}
