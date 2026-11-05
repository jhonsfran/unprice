import type { RateRow } from "@unprice/db/validators"
import { describeRatePrice } from "@unprice/services/pricing"
import { formatInstant } from "../../rate-cards/_components/rate-card-format"

/**
 * A plan feature's rows on its version's card, as the editor reads them. `rateCards.forPlanVersion`
 * returns rows in effect now or scheduled to start later; a row that has ended is dropped here.
 */
export type FeaturePriceRows = Readonly<{
  /** The default row (empty match) in effect at `now`. */
  current: RateRow | null
  /** The earliest default row that starts after `now`. */
  scheduled: RateRow | null
  /** Rows that match a dimension, such as a model price, in effect at `now` or starting later. */
  byDimension: readonly RateRow[]
}>

export function rowsByFeature(
  rows: readonly RateRow[],
  now: number
): Map<string, FeaturePriceRows> {
  const byFeature = new Map<
    string,
    { current: RateRow | null; scheduled: RateRow | null; byDimension: RateRow[] }
  >()
  for (const row of rows) {
    if (row.effectiveTo !== null && row.effectiveTo <= now) continue
    const entry = byFeature.get(row.featureSlug) ?? {
      current: null,
      scheduled: null,
      byDimension: [],
    }
    if (Object.keys(row.match).length > 0) entry.byDimension.push(row)
    else if (row.effectiveFrom <= now) entry.current = row
    else if (!entry.scheduled || row.effectiveFrom < entry.scheduled.effectiveFrom) {
      entry.scheduled = row
    }
    byFeature.set(row.featureSlug, entry)
  }
  return byFeature
}

/** "from Nov 5, 2026, 10:12 AM" for a row that has not started. */
export function scheduledFrom(row: Pick<RateRow, "effectiveFrom">): string {
  return `from ${formatInstant(row.effectiveFrom)}`
}

/**
 * One line for a feature header: the current price, else the scheduled one and when it starts,
 * else how many dimension prices it has, else "Not priced".
 */
export function describeFeaturePrice(
  entry: FeaturePriceRows | undefined,
  currency: string,
  unit: string
): string {
  if (entry?.current) return describeRatePrice(entry.current.price, currency, unit)
  if (entry?.scheduled) {
    return `${describeRatePrice(entry.scheduled.price, currency, unit)} ${scheduledFrom(entry.scheduled)}`
  }
  if (entry && entry.byDimension.length > 0) {
    const keys = new Set(entry.byDimension.flatMap((row) => Object.keys(row.match)))
    return `${entry.byDimension.length} prices by ${[...keys].join(", ")}`
  }
  return "Not priced"
}

/** The titles of plan features the card has no row for: what publishing refuses. */
export function unpricedFeatureTitles(
  features: readonly { feature: { slug: string; title: string } }[],
  rows: readonly RateRow[],
  now: number
): string[] {
  const priced = rowsByFeature(rows, now)
  const titles: string[] = []
  for (const { feature } of features) {
    const entry = priced.get(feature.slug)
    if (!entry || (!entry.current && !entry.scheduled && entry.byDimension.length === 0)) {
      titles.push(feature.title)
    }
  }
  return titles
}
