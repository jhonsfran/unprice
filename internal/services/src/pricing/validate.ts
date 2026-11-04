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

function overlaps(a: RateRow, b: RateRow): boolean {
  const aEnd = a.effectiveTo ?? Number.POSITIVE_INFINITY
  const bEnd = b.effectiveTo ?? Number.POSITIVE_INFINITY
  return a.effectiveFrom < bEnd && b.effectiveFrom < aEnd
}

function duplicates<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

/** Every rule a card's rows break, in row order; an empty list means the card is valid. */
export function validateCard(
  card: RateCard,
  rows: readonly RateRow[],
  features: readonly FeaturePricing[]
): CardViolation[] {
  const violations: CardViolation[] = []
  const featureBySlug = new Map(features.map((feature) => [feature.slug, feature]))

  for (const row of rows) {
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

  const keySets = new Set(
    rows.map((row) => Object.keys(row.match).sort().join(",")).filter((keySet) => keySet !== "")
  )
  if (keySets.size > 1) {
    violations.push({ code: "MIXED_MATCH_KEYS", feature: feature.slug, keySets: [...keySets] })
  }

  rows.forEach((row, index) => {
    for (const other of rows.slice(index + 1)) {
      if (matchKey(row.match) === matchKey(other.match) && overlaps(row, other)) {
        violations.push({
          code: "OVERLAPPING_ROWS",
          feature: feature.slug,
          rowIds: [row.id, other.id],
        })
      }
    }
  })
  return violations
}
