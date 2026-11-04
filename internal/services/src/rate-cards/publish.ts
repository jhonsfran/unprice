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
 * The writes that publish `drafts` on a card. A draft with an open row of the same feature and
 * match is a price change: it starts at least RATE_CHANGE_NOTICE_MS ahead and after the open
 * row's start, and closes that row where it starts. Any other draft opens a new row from `now` on.
 * The card that results must pass `validateCard`.
 */
export function planPublish(input: PlanPublishInput): Result<PublishPlan, UnPriceRateCardError> {
  const { card, rows, drafts, effectiveFrom, now, features } = input
  const known = new Set(features.map((feature) => feature.slug))
  const unknown = [...new Set(drafts.map((draft) => draft.featureSlug))].filter(
    (slug) => !known.has(slug)
  )
  if (unknown.length > 0) {
    return Err(new UnPriceRateCardError({ code: "UNKNOWN_FEATURE", features: unknown }))
  }

  const openRows = new Map(
    rows.filter((row) => row.effectiveTo === null).map((row) => [rowKey(row), row])
  )
  const closes: { rowId: string; effectiveTo: number }[] = []
  const inserts: RateRow[] = []
  let unchanged = 0

  for (const draft of drafts) {
    const open = openRows.get(rowKey(draft))
    if (open && samePricing(open, draft)) {
      unchanged++
      continue
    }
    const earliest = open ? now + RATE_CHANGE_NOTICE_MS : now
    if (effectiveFrom < earliest) {
      return Err(
        new UnPriceRateCardError({
          code: "NOTICE_TOO_SHORT",
          featureSlug: draft.featureSlug,
          earliest,
        })
      )
    }
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
  const closedAt = new Map(closes.map((close) => [close.rowId, close.effectiveTo]))
  const live = [
    ...rows.map((row) => ({ ...row, effectiveTo: closedAt.get(row.id) ?? row.effectiveTo })),
    ...inserts,
  ].filter((row) => row.effectiveTo === null || row.effectiveTo > now)
  const violations = validateCard(card, live, features)
  if (violations.length > 0) {
    return Err(new UnPriceRateCardError({ code: "INVALID_CARD", violations }))
  }
  return Ok({ closes, inserts, unchanged })
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
