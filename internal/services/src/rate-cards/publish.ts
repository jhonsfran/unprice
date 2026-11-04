import type {
  FeaturePricing,
  MeterConfig,
  RateCard,
  RateRow,
  RateRowDraft,
} from "@unprice/db/validators"
import { featurePricingSchema } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { matchKey, validateCard } from "../pricing"
import { UnPriceRateCardError } from "./errors"
import { canonicalJson } from "./wire"

/**
 * How far ahead a price change must start. A budget refreshes its card at least every 5 minutes
 * (ADR-0008 D2), so a change published with this notice never meets a budget pricing with a card
 * that predates it.
 */
export const RATE_CHANGE_NOTICE_MS = 10 * 60 * 1000

/** A row to publish and where its price came from. */
export type RowDraft = RateRowDraft & Pick<RateRow, "source" | "sourceRef">

export type PublishPlan = Readonly<{
  /** Open rows that end where their successor starts. */
  closes: readonly Readonly<{ rowId: string; effectiveTo: number }>[]
  inserts: readonly RateRow[]
  /** Drafts identical to their open row, so a retried publish writes nothing. */
  unchanged: number
}>

export type PlanPublishInput = Readonly<{
  card: RateCard
  rows: readonly RateRow[]
  drafts: readonly RowDraft[]
  effectiveFrom: number
  now: number
  features: readonly FeaturePricing[]
  newRowId: () => string
}>

function rowKey(row: Pick<RateRow, "featureSlug" | "match">): string {
  return `${row.featureSlug}|${matchKey(row.match)}`
}

function samePricing(a: Pick<RateRow, "price" | "cost">, b: Pick<RateRow, "price" | "cost">) {
  return canonicalJson([a.price, a.cost]) === canonicalJson([b.price, b.cost])
}

/**
 * The writes that publish `drafts` on a card. Once the card has a live or scheduled row, every
 * new row starts at least RATE_CHANGE_NOTICE_MS ahead, because a budget may still price with the
 * card as it was. A draft with an open row of the same feature and match is a price change: it
 * starts after the open row's start and closes that row where it starts. The inserted rows must
 * pass `validateCard` against the features they price, together with the live rows of those
 * features.
 */
export function planPublish(input: PlanPublishInput): Result<PublishPlan, UnPriceRateCardError> {
  const { card, rows, drafts, effectiveFrom, now, features } = input
  const openRows = new Map(
    rows.filter((row) => row.effectiveTo === null).map((row) => [rowKey(row), row])
  )
  const changed = drafts.filter((draft) => {
    const open = openRows.get(rowKey(draft))
    return !(open && samePricing(open, draft))
  })
  const unchanged = drafts.length - changed.length
  const [first] = changed
  if (!first) return Ok({ closes: [], inserts: [], unchanged })

  const known = new Set(features.map((feature) => feature.slug))
  const unknown = [...new Set(changed.map((draft) => draft.featureSlug))].filter(
    (slug) => !known.has(slug)
  )
  if (unknown.length > 0) {
    return Err(new UnPriceRateCardError({ code: "UNKNOWN_FEATURE", features: unknown }))
  }

  const isLive = (row: Pick<RateRow, "effectiveTo">) =>
    row.effectiveTo === null || row.effectiveTo > now
  const earliest = rows.some(isLive) ? now + RATE_CHANGE_NOTICE_MS : now
  if (effectiveFrom < earliest) {
    return Err(
      new UnPriceRateCardError({
        code: "NOTICE_TOO_SHORT",
        featureSlug: first.featureSlug,
        earliest,
      })
    )
  }

  const closes: { rowId: string; effectiveTo: number }[] = []
  const inserts: RateRow[] = []
  for (const draft of changed) {
    const open = openRows.get(rowKey(draft))
    if (open && effectiveFrom <= open.effectiveFrom) {
      return Err(
        new UnPriceRateCardError({
          code: "SCHEDULE_CONFLICT",
          featureSlug: draft.featureSlug,
          scheduledFrom: open.effectiveFrom,
        })
      )
    }
    if (open) closes.push({ rowId: open.id, effectiveTo: effectiveFrom })
    inserts.push({
      ...draft,
      id: input.newRowId(),
      rateCardId: card.id,
      effectiveFrom,
      effectiveTo: null,
    })
  }

  // Rows that ended before now cannot overlap a row that starts at now or later.
  const touched = new Set(inserts.map((row) => row.featureSlug))
  const closedAt = new Map(closes.map((close) => [close.rowId, close.effectiveTo]))
  const live = [
    ...rows.map((row) => ({ ...row, effectiveTo: closedAt.get(row.id) ?? row.effectiveTo })),
    ...inserts,
  ].filter((row) => touched.has(row.featureSlug) && isLive(row))
  const violations = validateCard(
    card,
    live,
    features.filter((feature) => touched.has(feature.slug)),
    inserts
  )
  if (violations.length > 0) {
    return Err(new UnPriceRateCardError({ code: "INVALID_CARD", violations }))
  }
  return Ok({ closes, inserts, unchanged })
}

export type ClosePlan = Readonly<{
  closes: readonly Readonly<{ rowId: string; effectiveTo: number }>[]
  /** Rows already closed at `effectiveTo`, so a retried close writes nothing. */
  unchanged: number
}>

/**
 * The rows of `rowIds` to end at `effectiveTo`. Ending a row is a price change, so it takes the
 * same notice as a successor and must fall after the row starts.
 */
export function planClose(
  input: Readonly<{
    rows: readonly RateRow[]
    rowIds: readonly string[]
    effectiveTo: number
    now: number
  }>
): Result<ClosePlan, UnPriceRateCardError> {
  const { effectiveTo, now } = input
  const byId = new Map(input.rows.map((row) => [row.id, row]))
  const rowIds = [...new Set(input.rowIds)]
  const missing = rowIds.filter((rowId) => !byId.has(rowId))
  if (missing.length > 0) {
    return Err(new UnPriceRateCardError({ code: "ROW_NOT_FOUND", rowIds: missing }))
  }

  const closes: { rowId: string; effectiveTo: number }[] = []
  let unchanged = 0
  for (const row of rowIds.flatMap((rowId) => byId.get(rowId) ?? [])) {
    if (row.effectiveTo === effectiveTo) {
      unchanged++
      continue
    }
    if (row.effectiveTo !== null) {
      return Err(
        new UnPriceRateCardError({
          code: "ROW_CLOSED",
          rowId: row.id,
          effectiveTo: row.effectiveTo,
        })
      )
    }
    if (effectiveTo < now + RATE_CHANGE_NOTICE_MS) {
      return Err(
        new UnPriceRateCardError({
          code: "NOTICE_TOO_SHORT",
          featureSlug: row.featureSlug,
          earliest: now + RATE_CHANGE_NOTICE_MS,
        })
      )
    }
    if (effectiveTo <= row.effectiveFrom) {
      return Err(
        new UnPriceRateCardError({
          code: "SCHEDULE_CONFLICT",
          featureSlug: row.featureSlug,
          scheduledFrom: row.effectiveFrom,
        })
      )
    }
    closes.push({ rowId: row.id, effectiveTo })
  }
  return Ok({ closes, unchanged })
}

/**
 * What the pricing core knows about a feature today: its meter's group-by keys are the dimensions
 * a row may match on and its aggregation field is the metered property. `included` lives on the
 * plan feature, never on the card. A slug the pricing contract rejects cannot be priced.
 */
export function featurePricingOf(feature: {
  slug: string
  meterConfig?: MeterConfig | null
}): FeaturePricing | null {
  const parsed = featurePricingSchema.safeParse({
    slug: feature.slug,
    dimensions: feature.meterConfig?.groupBy ?? [],
    meterProperty: feature.meterConfig?.aggregationField ?? null,
    included: null,
  })
  return parsed.success ? parsed.data : null
}
