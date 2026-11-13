import type { FeaturePricing, RateCard, RateRow } from "@unprice/db/validators"
import { type CardViolation, matchKey } from "./model"

/** The properties a row prices; null is the per-event position. Flat rows price none. */
export function pricedProperties(row: RateRow): readonly (string | null)[] {
  switch (row.price.type) {
    case "unit":
      return row.price.components.map((component) => component.property)
    case "graduated":
    case "package":
      return [row.price.property]
    case "flat":
      return []
  }
}

type Interval = Readonly<{ effectiveFrom: number; effectiveTo: number | null }>

function overlaps(a: Interval, b: Interval): boolean {
  const aEnd = a.effectiveTo ?? Number.POSITIVE_INFINITY
  const bEnd = b.effectiveTo ?? Number.POSITIVE_INFINITY
  return a.effectiveFrom < bEnd && b.effectiveFrom < aEnd
}

function duplicates<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

/**
 * Every rule a card's rows break, in row order; an empty list means the card is valid. The rules
 * of a single row apply to `checked` (every row by default); the rules between rows apply to all
 * rows of `features`. Stored rows are immutable, so a publish checks only the rows it inserts: a
 * feature that changed after a row was stored cannot block the card.
 */
export function validateCard(
  card: RateCard,
  rows: readonly RateRow[],
  features: readonly FeaturePricing[],
  checked: readonly RateRow[] = rows
): CardViolation[] {
  const violations: CardViolation[] = []
  const featureBySlug = new Map(features.map((feature) => [feature.slug, feature]))

  for (const row of checked) {
    if (row.rateCardId !== card.id) violations.push({ code: "ROW_OF_OTHER_CARD", rowId: row.id })
    const feature = featureBySlug.get(row.featureSlug)
    if (!feature) {
      violations.push({ code: "UNKNOWN_FEATURE", rowId: row.id, feature: row.featureSlug })
      continue
    }
    violations.push(...rowViolations(row, feature))
  }

  for (const feature of features) {
    const featureRows = rows.filter((row) => row.featureSlug === feature.slug)
    violations.push(...featureViolations(feature, featureRows))
  }
  return violations
}

function rowViolations(row: RateRow, feature: FeaturePricing): CardViolation[] {
  const violations: CardViolation[] = []
  const rowId = row.id
  const hasDimensions = feature.dimensions.length > 0

  for (const key of Object.keys(row.match)) {
    if (!feature.dimensions.includes(key))
      violations.push({ code: "UNKNOWN_DIMENSION", rowId, key })
  }

  const price = row.price
  if (hasDimensions && (price.type === "graduated" || price.type === "package")) {
    violations.push({ code: "TIERED_WITH_DIMENSIONS", rowId })
  }

  if (price.type === "graduated") {
    const bounds = price.tiers.map((tier) => tier.upTo)
    const last = bounds.length - 1
    const ascending = bounds.every((upTo, index) => {
      if (index === last) return upTo === null
      const previous = index === 0 ? 0 : bounds[index - 1]
      return upTo !== null && typeof previous === "number" && upTo > previous
    })
    if (!ascending) violations.push({ code: "TIERS_INVALID", rowId })
  }

  const priced = pricedProperties(row)
  if (feature.included !== null && price.type !== "flat") {
    if (priced.length !== 1 || priced[0] !== feature.meterProperty) {
      violations.push({ code: "INCLUDED_NOT_SINGLE_QUANTITY", rowId })
    }
  }

  const costed = row.cost?.components.map((component) => component.property) ?? []
  for (const property of new Set([...duplicates(priced), ...duplicates(costed)])) {
    violations.push({ code: "DUPLICATE_PROPERTY", rowId, property })
  }
  for (const property of new Set(costed)) {
    if (!priced.includes(property)) {
      violations.push({ code: "COST_ON_UNPRICED_PROPERTY", rowId, property })
    }
  }
  return violations
}

function featureViolations(feature: FeaturePricing, rows: readonly RateRow[]): CardViolation[] {
  const violations: CardViolation[] = []
  if (feature.included !== null && feature.dimensions.length > 0) {
    violations.push({ code: "INCLUDED_WITH_DIMENSIONS", feature: feature.slug })
  }

  const byMatch = new Map<string, RateRow[]>()
  for (const row of rows) {
    const key = matchKey(row.match)
    const sameMatch = byMatch.get(key)
    if (sameMatch) sameMatch.push(row)
    else byMatch.set(key, [row])
  }
  const mixed = mixedKeySets(rows)
  if (mixed.length > 0) {
    violations.push({ code: "MIXED_MATCH_KEYS", feature: feature.slug, keySets: mixed })
  }

  for (const sameMatch of byMatch.values()) {
    sameMatch.forEach((row, index) => {
      for (const other of sameMatch.slice(index + 1)) {
        if (overlaps(row, other)) {
          violations.push({
            code: "OVERLAPPING_ROWS",
            feature: feature.slug,
            rowIds: [row.id, other.id],
          })
        }
      }
    })
  }
  return violations
}

/**
 * The key sets of a feature's dimension rows that are in force together with another key set, in
 * row order. Two key sets are mixed only while rows of both are in force, so a regrouped meter's
 * rows can follow the rows they replace, and a key set out of force in a gap mixes with nothing
 * there. One sweep over the rows sorted by start, counting the rows in force per key set.
 */
function mixedKeySets(rows: readonly RateRow[]): string[] {
  const keyed = rows
    .map((row) => ({ row, keySet: Object.keys(row.match).sort().join(",") }))
    .filter(({ keySet }) => keySet !== "")
  const end = ({ row }: (typeof keyed)[number]) => row.effectiveTo ?? Number.POSITIVE_INFINITY
  const byStart = [...keyed].sort((a, b) => a.row.effectiveFrom - b.row.effectiveFrom)
  const byEnd = [...keyed].sort((a, b) => (end(a) < end(b) ? -1 : end(a) > end(b) ? 1 : 0))
  const inForce = new Map<string, number>()
  const mixed = new Set<string>()
  let ended = 0
  for (const entry of byStart) {
    // Intervals are [from, to): a row that ends where this one starts is out of force.
    while (ended < byEnd.length) {
      const next = byEnd[ended]
      if (!next || end(next) > entry.row.effectiveFrom) break
      inForce.set(next.keySet, (inForce.get(next.keySet) ?? 0) - 1)
      ended++
    }
    for (const [other, count] of inForce) {
      if (other !== entry.keySet && count > 0) mixed.add(other).add(entry.keySet)
    }
    inForce.set(entry.keySet, (inForce.get(entry.keySet) ?? 0) + 1)
  }
  return [...new Set(keyed.map(({ keySet }) => keySet))].filter((keySet) => mixed.has(keySet))
}
