import type { MarginPolicy, RateRow, ratePriceSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import type { z } from "zod"

/** A row price as the publish procedure takes it: decimals as strings. */
export type RatePriceWire = z.input<typeof ratePriceSchema>

/** A cost-plus revision as the client reads it. */
export type CostPlusDraftWire = RouterOutputs["rateCards"]["previewCostPlus"]["draft"]

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

/** "money:USD" reads as "USD", "credits:ai" as "ai credits". */
export function formatCardUnit(unit: string): string {
  const [kind, id] = unit.split(":")
  return kind === "credits" ? `${id} credits` : (id ?? unit)
}

/** The currency or credit id a card's prices are written in. */
export function cardCurrency(unit: string): string {
  return unit.split(":")[1] ?? unit
}

export function formatMarginPolicy(policy: MarginPolicy): string {
  if (policy.type === "manual") return "Manual"
  return policy.features
    .map(
      (feature) =>
        `Cost-plus ${Number(formatAmount(feature.markup)) * 100}% on ${feature.featureSlug}`
    )
    .join(", ")
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

/** When a row applies: "since X", "X → Y", or "from X" for one that has not started. */
export function formatInterval(row: Pick<RateRow, "effectiveFrom" | "effectiveTo">, now: number) {
  const from = formatInstant(row.effectiveFrom)
  if (row.effectiveTo !== null) return `${from} → ${formatInstant(row.effectiveTo)}`
  return row.effectiveFrom > now ? `from ${from}` : `since ${from}`
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
