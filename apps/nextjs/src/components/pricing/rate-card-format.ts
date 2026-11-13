import type { MarginPolicy, RateRow, ratePriceSchema } from "@unprice/db/validators"
import { type Amount, formatAmount } from "@unprice/money"
import type { PricingShape } from "@unprice/services/pricing"
import type { PriceColumn, PriceTable } from "@unprice/services/pricing"
import { changeTableOf, lineLabel } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import type { z } from "zod"
import { type TierDraft, tiersOf } from "./tiers-model"

/** A row price as the publish procedure takes it: decimals as strings. */
export type RatePriceWire = z.input<typeof ratePriceSchema>

/** A cost-plus revision as the client reads it. */
export type CostPlusDraftWire = RouterOutputs["rateCards"]["previewCostPlus"]["draft"]

export type CostPlusFeaturePolicy = Extract<MarginPolicy, { type: "costPlus" }>["features"][number]

/** How many of the draft's changes publishing writes as rows. */
export function countWrites(draft: CostPlusDraftWire): number {
  return draft.changes.filter((change) => change.type === "added" || change.type === "changed")
    .length
}

export const RATE_CARDS_DESCRIPTION =
  "Every price lives on a rate card. A plan version prices with one card per currency; a price change is a new row, not a new plan version."

const DATE_TIME = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
})

const DAY = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

/** "money:USD" reads as "USD", "credits:ai" as "ai credits". */
export function formatCardUnit(unit: string): string {
  const [kind, id] = unit.split(":")
  return kind === "credits" ? `${id} credits` : (id ?? unit)
}

/** The currency or credit id a card's prices are written in. */
export function cardCurrency(unit: string): string {
  return unit.split(":")[1] ?? unit
}

/** "0.3" as "30". */
export function markupPercent(markup: Amount): string {
  return formatAmount(markup * BigInt(100))
}

export function formatMarginPolicy(policy: MarginPolicy): string {
  if (policy.type === "manual") return "Manual"
  return policy.features
    .map((feature) => `Cost-plus ${markupPercent(feature.markup)}% on ${feature.featureSlug}`)
    .join(", ")
}

/** The catalog policy pricing a feature, when the card has one. */
export function catalogPolicyFor(
  policy: MarginPolicy,
  featureSlug: string
): CostPlusFeaturePolicy | null {
  if (policy.type !== "costPlus") return null
  return policy.features.find((feature) => feature.featureSlug === featureSlug) ?? null
}

/** A row's match as "model=gpt-4o, region=eu", or "Default" for the empty match. */
export function formatMatch(match: Readonly<Record<string, string>>): string {
  const entries = Object.entries(match)
  return entries.length === 0
    ? "Default"
    : entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

export function formatInstant(ms: number): string {
  return DATE_TIME.format(new Date(ms))
}

export function formatDay(ms: number): string {
  return DAY.format(new Date(ms))
}

/**
 * What the card's state means for a price change, in words: a live card is priced by a published
 * version, so a change starts after the notice.
 */
export function describeCardState(live: boolean): string {
  return live
    ? "A published version charges these prices. A change you publish starts 10 minutes later, so running budgets pick it up first."
    : "No customer pays these prices yet, so a change starts at once."
}

export type MatrixStatus = "current" | "scheduled" | "ended" | "added" | "changed" | "retiring"

/** One cell of a price matrix: the rate, and the rate it replaces in a change view. */
export type MatrixCell = Readonly<{ after: Amount | null; before: Amount | null }>

/** One line of a price matrix, labelled by its dimension values. */
export type MatrixLine = Readonly<{
  key: string
  label: string
  status: MatrixStatus
  cells: ReadonlyMap<string, MatrixCell>
  /** The price in words, for a line the columns cannot show. */
  text: string | null
  /** When the line applies, in words; empty for a change that has no date yet. */
  applies: string
  row: RateRow | null
}>

export type Matrix = Readonly<{
  dimensions: readonly string[]
  columns: readonly PriceColumn[]
  lines: readonly MatrixLine[]
}>

const TIME = new Intl.DateTimeFormat("en", { timeStyle: "short" })

/** An instant after `from`: only its time when it falls on the same day. */
function formatAfter(from: number, instant: number): string {
  return formatDay(from) === formatDay(instant)
    ? TIME.format(new Date(instant))
    : formatInstant(instant)
}

/** When a line applies, in words: "since Nov 5, 2026", "since Nov 5, 2026 until 9:50 PM", "from Nov 5, 2026, 9:50 PM". */
export function appliesText(
  row: Pick<RateRow, "effectiveFrom" | "effectiveTo">,
  status: MatrixStatus
): string {
  switch (status) {
    case "scheduled":
      return `from ${formatInstant(row.effectiveFrom)}`
    case "ended":
      return `${formatDay(row.effectiveFrom)} to ${formatDay(row.effectiveTo ?? row.effectiveFrom)}`
    default:
      return row.effectiveTo === null
        ? `since ${formatDay(row.effectiveFrom)}`
        : `since ${formatDay(row.effectiveFrom)} until ${formatAfter(row.effectiveFrom, row.effectiveTo)}`
  }
}

/** A price table's current and scheduled lines as a matrix; `ended` for its history. */
export function matrixOf(table: PriceTable, which: "lines" | "ended" = "lines"): Matrix {
  return {
    dimensions: table.dimensions,
    columns: table.columns,
    lines: table[which].map((line) => ({
      key: line.key,
      label: lineLabel(line, table.dimensions),
      status: line.status,
      cells: new Map(
        [...line.cells].map(([key, amount]) => [key, { after: amount, before: null }])
      ),
      text: line.text,
      applies: appliesText(line.row, line.status),
      row: line.row,
    })),
  }
}

/** A catalog change table with UI date labels. */
export function changeMatrixOf(draft: CostPlusDraftWire, featureSlug: string): Matrix {
  const table = changeTableOf(draft, featureSlug)
  return {
    dimensions: table.dimensions,
    columns: table.columns,
    lines: table.lines.map(({ change, current, cells }) => ({
      key: formatMatch(change.proposed.match),
      label: lineLabel({ match: change.proposed.match }, table.dimensions),
      status: change.type,
      cells,
      text: null,
      applies:
        change.type === "retiring" && current?.effectiveTo
          ? `ends ${formatInstant(current.effectiveTo)}`
          : "",
      row: current,
    })),
  }
}

/** "3 changed, 2 new" for a change matrix; empty when nothing changes. */
export function describeChanges(matrix: Matrix): string {
  const counts = { changed: 0, added: 0, retiring: 0 }
  for (const line of matrix.lines) {
    if (line.status === "changed" || line.status === "added" || line.status === "retiring") {
      counts[line.status] += 1
    }
  }
  const parts: string[] = []
  if (counts.changed > 0) parts.push(`${counts.changed} changed`)
  if (counts.added > 0) parts.push(`${counts.added} new`)
  if (counts.retiring > 0) parts.push(`${counts.retiring} ending`)
  return parts.join(", ")
}

/**
 * Whether a catalog row was priced from one of the project's own model costs: a catalog row's
 * `sourceRef` is the id of its cost row, and custom cost ids carry the `cmc` prefix (`newId`).
 */
export function isCustomCostRow(row: Pick<RateRow, "source" | "sourceRef">): boolean {
  return row.source === "catalog" && (row.sourceRef?.startsWith("cmc_") ?? false)
}

export function openRows(rows: readonly RateRow[]): RateRow[] {
  return rows.filter((row) => row.effectiveTo === null)
}

/**
 * The earliest start a scheduled publish can take: now for a card no published version prices
 * with, otherwise now plus the notice and a minute of slack for the time the form stays open.
 */
export function earliestStart(live: boolean, now: number, noticeMs: number): number {
  return live ? now + noticeMs + 60_000 : now
}

/** The publish form's price fields, as typed. */
export type PriceFields = {
  shape: PricingShape
  /** unit and package rate, flat amount */
  amount: string
  /** unit `per`, package `size` */
  per: string
  /** The event property a usage row counts; empty for one unit per event. */
  property: string
  /** The tier editor values. */
  tiers: readonly TierDraft[]
}

/** A row price in its wire form, ready for `rateCards.publishRows`; a message when it is incomplete. */
export function buildRatePrice(
  fields: PriceFields
): { ok: true; price: RatePriceWire } | { ok: false; message: string } {
  const property = fields.property.trim() || null
  const count = Number(fields.per || "1")
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, message: "Per and size are whole numbers of at least 1" }
  }
  switch (fields.shape) {
    case "flat":
      return { ok: true, price: { type: "flat", amount: fields.amount.trim() } }
    case "unit":
      return {
        ok: true,
        price: {
          type: "unit",
          components: [{ property, rate: fields.amount.trim(), per: count }],
        },
      }
    case "package":
      return {
        ok: true,
        price: { type: "package", property, size: count, rate: fields.amount.trim() },
      }
    case "graduated": {
      const built = tiersOf(fields.tiers)
      return built.ok
        ? { ok: true, price: { type: "graduated", property, per: 1, tiers: built.tiers } }
        : built
    }
  }
}
