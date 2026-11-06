import type { MarginPolicy, RateComponent, RateRow, ratePriceSchema } from "@unprice/db/validators"
import { type Amount, formatAmount } from "@unprice/money"
import type { PriceColumn, PriceTable } from "@unprice/services/pricing"
import { columnKey, lineLabel } from "@unprice/services/pricing"
import type { RouterOutputs } from "@unprice/trpc/routes"
import type { z } from "zod"

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
  return String(Number(formatAmount(markup)) * 100)
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

/** When a row applies: "since X", "X → Y", or "from X" for one that has not started. */
export function formatInterval(row: Pick<RateRow, "effectiveFrom" | "effectiveTo">, now: number) {
  const from = formatInstant(row.effectiveFrom)
  if (row.effectiveTo !== null) return `${from} → ${formatInstant(row.effectiveTo)}`
  return row.effectiveFrom > now ? `from ${from}` : `since ${from}`
}

/**
 * What the card's state means for a price change, in words: a live card is priced by a published
 * version, so a change starts after the notice.
 */
export function describeCardState(live: boolean): string {
  return live
    ? "Live: a published version charges these prices. A change you publish starts 10 minutes later, so running budgets pick it up first."
    : "Draft: no published version charges these prices yet, so a change starts at once."
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

function cellsOf(
  after: readonly RateComponent[],
  before: readonly RateComponent[]
): Map<string, MatrixCell> {
  const cells = new Map<string, MatrixCell>()
  for (const component of after) {
    const key = columnKey({ property: component.property, per: component.per })
    const was = before.find((c) => c.property === component.property && c.per === component.per)
    cells.set(key, { after: component.rate, before: was?.rate ?? null })
  }
  for (const component of before) {
    const key = columnKey({ property: component.property, per: component.per })
    if (!cells.has(key)) cells.set(key, { after: null, before: component.rate })
  }
  return cells
}

/**
 * What a catalog revision changes for one feature, as a matrix of only the lines that change:
 * new models, models whose rates moved (the old rate beside the new), and rows left to end.
 */
export function changeMatrixOf(draft: CostPlusDraftWire, featureSlug: string): Matrix {
  const changes = draft.changes.filter(
    (change): change is Exclude<typeof change, { type: "unchanged" }> =>
      change.proposed.featureSlug === featureSlug && change.type !== "unchanged"
  )
  const columns = new Map<string, PriceColumn>()
  const dimensions = new Set<string>()
  for (const change of changes) {
    for (const key of Object.keys(change.proposed.match)) dimensions.add(key)
    const current =
      "current" in change && change.current.price.type === "unit"
        ? change.current.price.components
        : []
    for (const component of [...change.proposed.price.components, ...current]) {
      const column = { property: component.property, per: component.per }
      columns.set(columnKey(column), column)
    }
  }
  const sortedDimensions = [...dimensions].sort()
  return {
    dimensions: sortedDimensions,
    columns: [...columns.values()],
    lines: changes.map((change) => {
      const current = "current" in change ? change.current : null
      return {
        key: formatMatch(change.proposed.match),
        label: lineLabel({ match: change.proposed.match }, sortedDimensions),
        status: change.type,
        cells: cellsOf(
          change.proposed.price.components,
          current?.price.type === "unit" ? current.price.components : []
        ),
        text: null,
        applies:
          change.type === "retiring" && current?.effectiveTo
            ? `ends ${formatInstant(current.effectiveTo)}`
            : "",
        row: current,
      }
    }),
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

export type FeatureRows = { featureSlug: string; current: RateRow[]; ended: RateRow[] }

/**
 * A card's rows grouped by feature, in feature order: the rows that apply now or later, and the
 * rows that have ended (newest first).
 */
export function groupRowsByFeature(rows: readonly RateRow[], now: number): FeatureRows[] {
  const groups = new Map<string, FeatureRows>()
  for (const row of rows) {
    const group = groups.get(row.featureSlug) ?? {
      featureSlug: row.featureSlug,
      current: [],
      ended: [],
    }
    if (row.effectiveTo !== null && row.effectiveTo <= now) group.ended.push(row)
    else group.current.push(row)
    groups.set(row.featureSlug, group)
  }
  for (const group of groups.values()) {
    group.ended.sort((left, right) => (right.effectiveTo ?? 0) - (left.effectiveTo ?? 0))
  }
  return [...groups.values()].sort((left, right) =>
    left.featureSlug.localeCompare(right.featureSlug)
  )
}

/** The rows a publish or close can end: open and not yet scheduled to end. */
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

/** A `datetime-local` input value for an instant, in the browser's time zone. */
export function toDateTimeLocal(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** "key=value, key=value" back into a match; null when a pair has no key. */
export function parseMatch(text: string): Record<string, string> | null {
  const match: Record<string, string> = {}
  for (const pair of text.split(",")) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const [key, ...rest] = trimmed.split("=")
    const name = key?.trim()
    if (!name || rest.length === 0) return null
    match[name] = rest.join("=").trim()
  }
  return match
}

/**
 * Graduated tiers from one line per tier, "upTo rate flat", where the last tier's upTo is "*".
 * Null when a line does not parse.
 */
export function parseTiers(
  text: string
): { upTo: number | null; rate: string; flat: string }[] | null {
  const tiers: { upTo: number | null; rate: string; flat: string }[] = []
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    const [upTo, rate, flat = "0"] = parts
    if (!upTo || !rate) return null
    const bound = upTo === "*" ? null : Number(upTo)
    if (bound !== null && !Number.isInteger(bound)) return null
    tiers.push({ upTo: bound, rate, flat })
  }
  return tiers.length > 0 ? tiers : null
}

export type PriceKind = "unit" | "flat" | "package" | "graduated"

/** The publish form's price fields, as typed. */
export type PriceFields = {
  kind: PriceKind
  /** unit and package rate, flat amount */
  amount: string
  /** unit `per`, package `size` */
  per: string
  /** The event property a usage row counts; empty for one unit per event. */
  property: string
  /** graduated tiers, one "upTo rate flat" line per tier */
  tiers: string
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
  switch (fields.kind) {
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
      const tiers = parseTiers(fields.tiers)
      if (!tiers) {
        return { ok: false, message: 'Write one tier per line: "upTo rate flat", last upTo "*"' }
      }
      return { ok: true, price: { type: "graduated", property, per: 1, tiers } }
    }
  }
}
