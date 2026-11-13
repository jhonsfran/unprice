import type { RateComponent, RatePrice, RateRow } from "@unprice/db/validators"
import type { Amount } from "@unprice/money"
import type { CostPlusDraft } from "./cost-plus"
import { matchKey } from "./model"
import { describeRatePrice, describeTiers, tierRanges } from "./plan-prices"

// A feature's rows as a price table: the way every LLM vendor publishes model prices (a row per
// model, a column per token kind, "$ per 1M tokens" in the header). A unit row contributes one
// cell per component; a flat, package or graduated row has no columns and is described instead.

/** One column: a component property at the quantity its rate is per. */
export type PriceColumn = Readonly<{ property: string | null; per: number }>

export type PriceLineStatus = "current" | "scheduled" | "ended"

/** One row of the table: what it matches, what it costs, and when it applies. */
export type PriceLine = Readonly<{
  key: string
  match: Readonly<Record<string, string>>
  row: RateRow
  status: PriceLineStatus
  /** Rate per column key; a column the row has no component for is absent. */
  cells: ReadonlyMap<string, Amount>
  /** The whole price in words, for a row the columns cannot show (or a table with no columns). */
  text: string | null
}>

export type PriceTable = Readonly<{
  featureSlug: string
  /** The match keys the lines vary by, sorted; empty when only the default row exists. */
  dimensions: readonly string[]
  columns: readonly PriceColumn[]
  /** Lines in effect now, then scheduled ones, by match then start. */
  lines: readonly PriceLine[]
  /** Lines that ended before now, newest first. */
  ended: readonly PriceLine[]
}>

export function columnKey(column: PriceColumn): string {
  return `${column.property ?? ""}|${column.per}`
}

/** The order the columns take: the catalog's token kinds first, then by name. */
const COLUMN_RANK: readonly RegExp[] = [
  /^(input|prompt)/,
  /^(output|completion)/,
  /^cache_?read|^cached/,
  /^cache_?(write|creation)/,
  /^reasoning/,
]

function columnRank(property: string | null): number {
  if (property === null) return COLUMN_RANK.length + 1
  const rank = COLUMN_RANK.findIndex((pattern) => pattern.test(property))
  return rank === -1 ? COLUMN_RANK.length : rank
}

function compareColumns(a: PriceColumn, b: PriceColumn): number {
  const byRank = columnRank(a.property) - columnRank(b.property)
  if (byRank !== 0) return byRank
  const byName = (a.property ?? "").localeCompare(b.property ?? "")
  return byName !== 0 ? byName : a.per - b.per
}

/** "input_tokens" reads as "Input", "cache_read_tokens" as "Cache read"; a per-event column is "Rate". */
export function columnLabel(column: PriceColumn): string {
  if (column.property === null) return "Rate"
  const words = column.property
    .replace(/[_.-]+/g, " ")
    .replace(/\btokens?\b/g, "")
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : column.property
}

const count = new Intl.NumberFormat("en")

/** What a column's rates are per: "1M tokens", "1K calls", "call". */
export function perLabel(column: PriceColumn, unit: string): string {
  if (column.per === 1) return unit
  const noun =
    column.property !== null && /tokens?$/.test(column.property) ? "tokens" : plural(unit)
  if (column.per === 1_000_000) return `1M ${noun}`
  if (column.per === 1_000) return `1K ${noun}`
  return `${count.format(column.per)} ${noun}`
}

function plural(unit: string): string {
  return /s$/i.test(unit) ? unit : `${unit}s`
}

function unitComponents(price: RatePrice): readonly RateComponent[] | null {
  return price.type === "unit" ? price.components : null
}

function statusAt(row: Pick<RateRow, "effectiveFrom" | "effectiveTo">, now: number) {
  if (row.effectiveTo !== null && row.effectiveTo <= now) return "ended"
  return row.effectiveFrom > now ? "scheduled" : "current"
}

/**
 * A price in words for a line without cells: "1-3 seats: $0 / seat · 4+ seats: $10 / seat" for
 * tiers, else the one-line summary.
 */
export function describeLine(price: RatePrice, currency: string, unit: string): string {
  if (price.type === "graduated") {
    const descriptions = describeTiers(price, currency, unit)
    return tierRanges(price.tiers)
      .map((tier, index) => {
        const range =
          tier.upTo === null
            ? `${tier.from}+ ${plural(unit)}`
            : tier.upTo === tier.from
              ? `${tier.from} ${unit}`
              : `${tier.from}-${tier.upTo} ${plural(unit)}`
        return `${range}: ${descriptions[index]?.value ?? ""}`
      })
      .join(" · ")
  }
  return describeRatePrice(price, currency, unit)
}

/**
 * The table of one feature's rows. Columns are the union of the unit rows' components; a line
 * whose price has no components keeps its description instead of cells.
 */
export function priceTableOf(
  featureSlug: string,
  rows: readonly RateRow[],
  now: number,
  currency: string,
  unit: string
): PriceTable {
  const featureRows = rows.filter((row) => row.featureSlug === featureSlug)
  const columns = new Map<string, PriceColumn>()
  const dimensions = new Set<string>()
  for (const row of featureRows) {
    for (const key of Object.keys(row.match)) dimensions.add(key)
    for (const component of unitComponents(row.price) ?? []) {
      const column = { property: component.property, per: component.per }
      columns.set(columnKey(column), column)
    }
  }
  const sortedColumns = [...columns.values()].sort(compareColumns)

  const lines = featureRows.map((row): PriceLine => {
    const components = unitComponents(row.price)
    const cells = new Map<string, Amount>()
    for (const component of components ?? []) {
      cells.set(columnKey({ property: component.property, per: component.per }), component.rate)
    }
    return {
      key: `${matchKey(row.match)}@${row.effectiveFrom}`,
      match: row.match,
      row,
      status: statusAt(row, now),
      cells,
      text: components ? null : describeLine(row.price, currency, unit),
    }
  })

  const byMatchThenStart = (a: PriceLine, b: PriceLine) => {
    const byMatch = matchKey(a.match).localeCompare(matchKey(b.match))
    return byMatch !== 0 ? byMatch : a.row.effectiveFrom - b.row.effectiveFrom
  }

  return {
    featureSlug,
    dimensions: [...dimensions].sort(),
    columns: sortedColumns,
    lines: lines.filter((line) => line.status !== "ended").sort(byMatchThenStart),
    ended: lines
      .filter((line) => line.status === "ended")
      .sort((a, b) => (b.row.effectiveTo ?? 0) - (a.row.effectiveTo ?? 0)),
  }
}

/** The feature slugs among `rows`, in the order they first appear, so a card lists each once. */
export function featureSlugsOf(rows: readonly RateRow[]): string[] {
  return [...new Set(rows.map((row) => row.featureSlug))]
}

/** The line's match as its dimension values only: "claude-haiku-5-5", or "Default". */
export function lineLabel(line: Pick<PriceLine, "match">, dimensions: readonly string[]): string {
  if (dimensions.length === 0 || Object.keys(line.match).length === 0) return "Default"
  return dimensions.map((key) => line.match[key] ?? "any").join(" · ")
}

/** A catalog revision with the same column order as the current-price table. */
export function changeTableOf(draft: CostPlusDraft, featureSlug: string) {
  const changes = draft.changes.filter(
    (change): change is Exclude<typeof change, { type: "unchanged" }> =>
      change.proposed.featureSlug === featureSlug && change.type !== "unchanged"
  )
  const columns = new Map<string, PriceColumn>()
  const dimensions = new Set<string>()
  const lines = changes.map((change) => {
    const current = "current" in change ? change.current : null
    const before = current?.price.type === "unit" ? current.price.components : []
    const after = change.proposed.price.components
    for (const key of Object.keys(change.proposed.match)) dimensions.add(key)
    const cells = new Map<string, { after: Amount | null; before: Amount | null }>()
    for (const component of [...after, ...before]) {
      const column = { property: component.property, per: component.per }
      const key = columnKey(column)
      columns.set(key, column)
      if (!cells.has(key))
        cells.set(key, {
          after:
            after.find((item) => item.property === column.property && item.per === column.per)
              ?.rate ?? null,
          before:
            before.find((item) => item.property === column.property && item.per === column.per)
              ?.rate ?? null,
        })
    }
    return { change, current, cells }
  })
  return {
    dimensions: [...dimensions].sort(),
    columns: [...columns.values()].sort(compareColumns),
    lines,
  }
}
