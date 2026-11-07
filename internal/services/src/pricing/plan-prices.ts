import {
  type FeatureType,
  type RatePrice,
  type RateRow,
  ratePriceSchema,
  type usageModeSchema,
} from "@unprice/db/validators"
import { type Amount, formatAmount, formatMoney } from "@unprice/money"
import type { z } from "zod"
import { isEffective } from "./resolve"

type UsageMode = z.infer<typeof usageModeSchema>

/** One graduated tier as decimal strings, inclusive unit bounds (the monetization document form). */
export type DecimalTier = Readonly<{
  firstUnit: number
  lastUnit: number | null
  unitPrice: string
  flatPrice: string
}>

/**
 * A feature's price as templates and the monetization document write it: one decimal price, or
 * graduated tiers. It becomes the feature's default row on the plan version's rate card.
 */
export type DecimalFeaturePrice = Readonly<{
  featureType: FeatureType
  usageMode?: UsageMode
  /** The package size, for package pricing. */
  units?: number
  price?: string
  tiers?: readonly DecimalTier[]
}>

/** The row shape a plan feature's package allows: what the feature fixes, the price only rates. */
export type PricingShape = "flat" | "unit" | "package" | "graduated"

export function pricingShape(
  input: Pick<DecimalFeaturePrice, "featureType" | "usageMode">
): PricingShape {
  switch (input.featureType) {
    case "flat":
      return "flat"
    case "tier":
      return "graduated"
    case "package":
      return "package"
    case "usage":
      if (input.usageMode === "tier") return "graduated"
      if (input.usageMode === "package") return "package"
      return "unit"
  }
}

/**
 * The rate price of a decimal feature price, or null when a field its shape needs is missing.
 * `property` is the event property usage rows count (the meter's aggregation field), null for one
 * unit per event; recurring features ignore it.
 */
export function ratePriceOf(input: DecimalFeaturePrice, property: string | null): RatePrice | null {
  const recurring = input.featureType !== "usage"
  const quantityProperty = recurring ? null : property
  switch (pricingShape(input)) {
    case "flat":
      return input.price === undefined
        ? null
        : ratePriceSchema.parse({ type: "flat", amount: input.price })
    case "unit":
      return input.price === undefined
        ? null
        : ratePriceSchema.parse({
            type: "unit",
            components: [{ property: quantityProperty, rate: input.price, per: 1 }],
          })
    case "package":
      return input.price === undefined || !input.units
        ? null
        : ratePriceSchema.parse({
            type: "package",
            property: quantityProperty,
            size: input.units,
            rate: input.price,
          })
    case "graduated":
      return !input.tiers || input.tiers.length === 0
        ? null
        : ratePriceSchema.parse({
            type: "graduated",
            property: quantityProperty,
            per: 1,
            tiers: input.tiers.map((tier) => ({
              upTo: tier.lastUnit,
              rate: tier.unitPrice,
              flat: tier.flatPrice,
            })),
          })
  }
}

/**
 * The decimal price of a feature's default row, the inverse of `ratePriceOf`; null when the row
 * has a shape the decimal form cannot state (several components, a `per` above 1).
 */
export function decimalPriceOf(
  price: RatePrice
): Readonly<{ price?: string; tiers?: DecimalTier[]; units?: number }> | null {
  switch (price.type) {
    case "flat":
      return { price: formatAmount(price.amount) }
    case "unit": {
      const [component] = price.components
      if (price.components.length !== 1 || !component || component.per !== 1) return null
      return { price: formatAmount(component.rate) }
    }
    case "package":
      return { price: formatAmount(price.rate), units: price.size }
    case "graduated": {
      if (price.per !== 1) return null
      let firstUnit = 1
      const tiers: DecimalTier[] = []
      for (const tier of price.tiers) {
        tiers.push({
          firstUnit,
          lastUnit: tier.upTo,
          unitPrice: formatAmount(tier.rate),
          flatPrice: formatAmount(tier.flat),
        })
        firstUnit = (tier.upTo ?? 0) + 1
      }
      return { tiers }
    }
  }
}

/** The rows in effect at `at`. */
export function rowsAt(rows: readonly RateRow[], at: number): RateRow[] {
  return rows.filter((row) => isEffective(row, at))
}

/** A feature's default row (empty match) among `rows`, or its first row when it has none. */
export function featureRow(rows: readonly RateRow[], featureSlug: string): RateRow | null {
  const featureRows = rows.filter((row) => row.featureSlug === featureSlug)
  return featureRows.find((row) => Object.keys(row.match).length === 0) ?? featureRows[0] ?? null
}

/** Whether any price in the row can charge more than zero. */
export function priceCanCharge(price: RatePrice): boolean {
  const zero = BigInt(0)
  switch (price.type) {
    case "flat":
      return price.amount > zero
    case "unit":
      return price.components.some((component) => component.rate > zero)
    case "package":
      return price.rate > zero
    case "graduated":
      return price.tiers.some((tier) => tier.rate > zero || tier.flat > zero)
  }
}

/** A price amount for display; sub-cent rates keep their digits. */
export function formatRateAmount(amount: Amount, currency: string): string {
  return formatMoney(formatAmount(amount), currency, { maximumFractionDigits: 8 })
}

function per(count: number, unit: string): string {
  return count === 1 ? unit : `${new Intl.NumberFormat("en").format(count)} ${unit}`
}

/** One line per tier of a graduated price: its unit range and what it costs. */
export function describeTiers(
  price: Extract<RatePrice, { type: "graduated" }>,
  currency: string,
  unit = "unit"
): { label: string; value: string }[] {
  let first = 1
  return price.tiers.map((tier) => {
    const label = `${first}-${tier.upTo ?? "∞"} ${unit}`
    first = (tier.upTo ?? 0) + 1
    const rate = `${formatRateAmount(tier.rate, currency)} / ${per(price.per, unit)}`
    const value =
      tier.flat > BigInt(0) ? `${formatRateAmount(tier.flat, currency)} + ${rate}` : rate
    return { label, value }
  })
}

/** A one-line summary of a price, such as "$0.02 / call" or "$49". */
export function describeRatePrice(price: RatePrice, currency: string, unit = "unit"): string {
  switch (price.type) {
    case "flat":
      return formatRateAmount(price.amount, currency)
    case "unit":
      return price.components
        .map(
          (component) =>
            `${formatRateAmount(component.rate, currency)} / ${per(component.per, component.property ?? unit)}`
        )
        .join(" + ")
    case "package":
      return `${formatRateAmount(price.rate, currency)} / ${per(price.size, unit)}`
    case "graduated": {
      const [first] = price.tiers
      if (!first) return "graduated"
      const tiers = price.tiers.length
      return `${formatRateAmount(first.rate, currency)} / ${per(price.per, unit)} (${tiers} ${tiers === 1 ? "tier" : "tiers"})`
    }
  }
}

/**
 * What a pricing card shows for a plan version priced by its card's `rows`: the sum of the flat
 * features' flat rows, and each feature's current price (null when the card has no row for it).
 */
export function planVersionPrices(
  planFeatures: readonly {
    featureType: FeatureType
    unitOfMeasure?: string | null
    feature: { slug: string }
  }[],
  rows: readonly RateRow[],
  currency: string
): { flatPrice: string; displayPrices: Map<string, string | null> } {
  let flatTotal = BigInt(0)
  const displayPrices = new Map<string, string | null>()
  for (const planFeature of planFeatures) {
    const row = featureRow(rows, planFeature.feature.slug)
    if (planFeature.featureType === "flat" && row?.price.type === "flat") {
      flatTotal += row.price.amount
    }
    const unit = (planFeature.unitOfMeasure ?? "units").replace(/s$/, "")
    displayPrices.set(
      planFeature.feature.slug,
      row ? describeRatePrice(row.price, currency, unit) : null
    )
  }
  return { flatPrice: formatRateAmount(flatTotal, currency), displayPrices }
}
