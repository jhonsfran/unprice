import type {
  FeaturePricing,
  MeterConfig,
  RateCard,
  RateRow,
  RateRowDraft,
} from "@unprice/db/validators"
import { RATE_CHANGE_NOTICE_MS, featurePricingSchema } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { matchKey, validateCard } from "../pricing"
import { UnPriceRateCardError, type UnpriceableFeature } from "./errors"
import { canonicalJson } from "./wire"

export { RATE_CHANGE_NOTICE_MS }

/** A row to publish and where its price came from. */
export type RowDraft = RateRowDraft & Pick<RateRow, "source" | "sourceRef">

type RowClose = Readonly<{ rowId: string; effectiveTo: number }>

export type PublishPlan = Readonly<{
  /** Rows that end where the inserted rows start: replaced open rows and the rows named to close. */
  closes: readonly RowClose[]
  inserts: readonly RateRow[]
  /**
   * Drafts identical to their open row and named rows already ending at the start, so a retried
   * publish writes nothing.
   */
  unchanged: number
}>

export type PlanPublishInput = Readonly<{
  card: RateCard
  rows: readonly RateRow[]
  drafts: readonly RowDraft[]
  /** Open rows to end where the drafts start, such as the rows of a regrouped feature. */
  closeRowIds?: readonly string[]
  effectiveFrom: number
  now: number
  features: readonly FeaturePricing[]
  /** Project features the pricing core cannot read; a draft for one names the reason. */
  unpriceable?: readonly UnpriceableFeature[]
  newRowId: () => string
}>

function rowKey(row: Pick<RateRow, "featureSlug" | "match">): string {
  return `${row.featureSlug}|${matchKey(row.match)}`
}

function samePricing(a: Pick<RateRow, "price" | "cost">, b: Pick<RateRow, "price" | "cost">) {
  return canonicalJson([a.price, a.cost]) === canonicalJson([b.price, b.cost])
}

/**
 * ADR-0008 D2: once a card has any row, even an ended one, every row start and end on it takes
 * effect at least RATE_CHANGE_NOTICE_MS after `now`, because a budget may still price with the
 * card as it was. Only a card's first rows may start at once.
 */
function noticeRejection(
  rows: readonly RateRow[],
  at: number,
  now: number,
  featureSlug: string
): UnPriceRateCardError | null {
  const earliest = rows.length > 0 ? now + RATE_CHANGE_NOTICE_MS : now
  if (at >= earliest) return null
  return new UnPriceRateCardError({ code: "NOTICE_TOO_SHORT", featureSlug, earliest })
}

/**
 * The rows of `rowIds` that end at `effectiveTo`, and how many already end there. An end must fall
 * after the row starts, and a row that already ends elsewhere cannot be moved. The caller checks
 * the notice.
 */
function rowsToEnd(
  rows: readonly RateRow[],
  rowIds: readonly string[],
  effectiveTo: number
): Result<Readonly<{ ending: readonly RateRow[]; unchanged: number }>, UnPriceRateCardError> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const unique = [...new Set(rowIds)]
  const missing = unique.filter((rowId) => !byId.has(rowId))
  if (missing.length > 0) {
    return Err(new UnPriceRateCardError({ code: "ROW_NOT_FOUND", rowIds: missing }))
  }

  const ending: RateRow[] = []
  let unchanged = 0
  for (const row of unique.flatMap((rowId) => byId.get(rowId) ?? [])) {
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
    if (effectiveTo <= row.effectiveFrom) {
      return Err(
        new UnPriceRateCardError({
          code: "SCHEDULE_CONFLICT",
          featureSlug: row.featureSlug,
          scheduledFrom: row.effectiveFrom,
        })
      )
    }
    ending.push(row)
  }
  return Ok({ ending, unchanged })
}

/**
 * The writes that publish `drafts` on a card, and end the rows of `closeRowIds` where they start,
 * all in one plan, so a regrouped feature's new rows follow its old ones without a gap. Every
 * start and end takes the D2 notice once the card has a row. A draft with an open row of the same
 * feature and match is a price change: it starts after the open row's start and closes that row
 * where it starts. The inserted rows must pass `validateCard` against the features they price,
 * together with the live rows of those features.
 */
export function planPublish(input: PlanPublishInput): Result<PublishPlan, UnPriceRateCardError> {
  const { card, rows, drafts, effectiveFrom, now, features } = input
  const named = rowsToEnd(rows, input.closeRowIds ?? [], effectiveFrom)
  if (named.err) return Err(named.err)

  const openRows = new Map(
    rows.filter((row) => row.effectiveTo === null).map((row) => [rowKey(row), row])
  )
  const changed = drafts.filter((draft) => {
    const open = openRows.get(rowKey(draft))
    return !(open && samePricing(open, draft))
  })
  const unchanged = drafts.length - changed.length + named.val.unchanged
  const firstSlug = changed[0]?.featureSlug ?? named.val.ending[0]?.featureSlug
  if (firstSlug === undefined) return Ok({ closes: [], inserts: [], unchanged })

  const known = new Set(features.map((feature) => feature.slug))
  const unknown = [...new Set(changed.map((draft) => draft.featureSlug))].filter(
    (slug) => !known.has(slug)
  )
  if (unknown.length > 0) {
    const unpriceable = (input.unpriceable ?? []).filter((feature) =>
      unknown.includes(feature.slug)
    )
    if (unpriceable.length > 0) {
      return Err(new UnPriceRateCardError({ code: "FEATURE_NOT_PRICEABLE", features: unpriceable }))
    }
    return Err(new UnPriceRateCardError({ code: "UNKNOWN_FEATURE", features: unknown }))
  }

  const late = noticeRejection(rows, effectiveFrom, now, firstSlug)
  if (late) return Err(late)

  const closes: RowClose[] = []
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
  const replaced = new Set(closes.map((close) => close.rowId))
  for (const row of named.val.ending) {
    if (!replaced.has(row.id)) closes.push({ rowId: row.id, effectiveTo: effectiveFrom })
  }

  // Rows that ended before now cannot overlap a row that starts at now or later.
  const isLive = (row: Pick<RateRow, "effectiveTo">) =>
    row.effectiveTo === null || row.effectiveTo > now
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
  closes: readonly RowClose[]
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
  const { rows, effectiveTo, now } = input
  const ended = rowsToEnd(rows, input.rowIds, effectiveTo)
  if (ended.err) return Err(ended.err)
  const [first] = ended.val.ending
  const late = first ? noticeRejection(rows, effectiveTo, now, first.featureSlug) : null
  if (late) return Err(late)
  return Ok({
    closes: ended.val.ending.map((row) => ({ rowId: row.id, effectiveTo })),
    unchanged: ended.val.unchanged,
  })
}

/** Why the pricing core cannot read a feature, by the meter field that breaks its contract. */
const FEATURE_FIELDS: Readonly<Record<string, string>> = {
  slug: "slug",
  dimensions: "meter groupBy",
  meterProperty: "meter aggregationField",
}

export type FeaturePricingParse =
  | Readonly<{ ok: true; pricing: FeaturePricing }>
  | Readonly<{ ok: false; unpriceable: UnpriceableFeature }>

/**
 * What the pricing core knows about a feature today: its meter's group-by keys are the dimensions
 * a row may match on and its aggregation field is the metered property. `included` lives on the
 * plan feature, never on the card. A feature the pricing contract rejects cannot be priced, and
 * the parse says which field breaks it.
 */
export function featurePricingOf(feature: {
  slug: string
  meterConfig?: MeterConfig | null
}): FeaturePricingParse {
  const parsed = featurePricingSchema.safeParse({
    slug: feature.slug,
    dimensions: feature.meterConfig?.groupBy ?? [],
    meterProperty: feature.meterConfig?.aggregationField ?? null,
    included: null,
  })
  if (parsed.success) return { ok: true, pricing: parsed.data }
  const [issue] = parsed.error.issues
  const field = FEATURE_FIELDS[String(issue?.path[0])] ?? "feature"
  const reason = `${field}: ${issue?.message ?? "invalid"}`
  return { ok: false, unpriceable: { slug: feature.slug, reason } }
}
