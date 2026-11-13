import {
  type FeaturePricing,
  type FeatureType,
  type PlanVersionExtended,
  type RatePrice,
  type RateRow,
  featurePriceInputSchema,
  ratePriceSchema,
  typeFeatureSchema,
  unitSchema,
  usageModeSchema,
} from "@unprice/db/validators"
import { type Amount, formatAmount, formatMoney } from "@unprice/money"
import { z } from "zod"
import { pricedProperties } from "./validate"

const decimalFeaturePriceSchema = z.object(featurePriceInputSchema.shape).extend({
  featureType: typeFeatureSchema,
  usageMode: usageModeSchema.optional(),
  units: unitSchema.optional(),
})

export type DecimalFeaturePrice = z.infer<typeof decimalFeaturePriceSchema>

/** Inclusive ranges for display. Rate tiers store only their upper bounds. */
export function tierRanges<T extends { upTo: number | null }>(tiers: readonly T[]) {
  return tiers.map((tier, index) => ({
    ...tier,
    from: index === 0 ? 1 : (tiers[index - 1]?.upTo ?? 0) + 1,
  }))
}

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

/** Whether an open row still prices the feature's dimensions, shape and quantity. */
export function rowFits(
  row: RateRow,
  next: FeaturePricing,
  shape: PricingShape,
  units: number | undefined
): boolean {
  const keys = Object.keys(row.match)
  if (keys.length > 0) {
    return row.price.type === "unit" && keys.every((key) => next.dimensions.includes(key))
  }
  return (
    row.price.type === shape &&
    (row.price.type !== "package" || row.price.size === units) &&
    pricedProperties(row).every((property) => property === next.meterProperty)
  )
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
            tiers: input.tiers,
          })
  }
}

/**
 * The decimal price of a feature's default row, the inverse of `ratePriceOf`; null when the row
 * has a shape the decimal form cannot state (several components, a `per` above 1).
 */
export function decimalPriceOf(
  price: RatePrice
): Pick<DecimalFeaturePrice, "price" | "tiers" | "units"> | null {
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
      const tiers = price.tiers.map((tier) => ({
        upTo: tier.upTo,
        rate: formatAmount(tier.rate),
        flat: formatAmount(tier.flat),
      }))
      return { tiers }
    }
  }
}

/** A feature's default row (empty match); dimension prices have no single default. */
export function featureRow(rows: readonly RateRow[], featureSlug: string): RateRow | null {
  const featureRows = rows.filter((row) => row.featureSlug === featureSlug)
  return featureRows.find((row) => Object.keys(row.match).length === 0) ?? null
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
  return tierRanges(price.tiers).map((tier) => {
    const label = `${tier.from}-${tier.upTo ?? "∞"} ${unit}`
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
    const unit = singularUnit(planFeature.unitOfMeasure ?? "units")
    const featureRows = rows.filter(
      (candidate) => candidate.featureSlug === planFeature.feature.slug
    )
    displayPrices.set(
      planFeature.feature.slug,
      featureRows.length > 0
        ? describeFeaturePrice(
            {
              current: row,
              scheduled: null,
              byDimension: featureRows.filter(
                (candidate) => Object.keys(candidate.match).length > 0
              ),
            },
            currency,
            unit
          )
        : null
    )
  }
  return { flatPrice: formatRateAmount(flatTotal, currency), displayPrices }
}

/** Publish requires a card in the version's currency and a current or scheduled row per feature. */
export function versionReadiness(
  features: readonly { feature: { slug: string } }[],
  card: { rows: readonly RateRow[] } | undefined,
  at: number
) {
  return {
    hasCard: card !== undefined,
    unpricedFeatureSlugs: [...new Set(features.map(({ feature }) => feature.slug))].filter(
      (slug) =>
        !card?.rows.some(
          (row) => row.featureSlug === slug && (row.effectiveTo === null || row.effectiveTo > at)
        )
    ),
  }
}

/**
 * A plan feature's rows on its version's card, as the editor reads them. `rateCards.forPlanVersion`
 * returns rows in effect now or scheduled to start later; a row that has ended is dropped here.
 */
export type FeaturePriceRows = Readonly<{
  /** The default row (empty match) in effect at `now`. */
  current: RateRow | null
  /** The earliest default row that starts after `now`. */
  scheduled: RateRow | null
  /** Rows that match a dimension, such as a model price, in effect at `now` or starting later. */
  byDimension: readonly RateRow[]
}>

export function rowsByFeature(
  rows: readonly RateRow[],
  now: number
): Map<string, FeaturePriceRows> {
  const byFeature = new Map<
    string,
    { current: RateRow | null; scheduled: RateRow | null; byDimension: RateRow[] }
  >()
  for (const row of rows) {
    if (row.effectiveTo !== null && row.effectiveTo <= now) continue
    const entry = byFeature.get(row.featureSlug) ?? {
      current: null,
      scheduled: null,
      byDimension: [],
    }
    if (Object.keys(row.match).length > 0) entry.byDimension.push(row)
    else if (row.effectiveFrom <= now) entry.current = row
    else if (!entry.scheduled || row.effectiveFrom < entry.scheduled.effectiveFrom) {
      entry.scheduled = row
    }
    byFeature.set(row.featureSlug, entry)
  }
  return byFeature
}

/** "from Nov 5, 2026, 10:12 AM" for a row that has not started. */
export function scheduledFrom(row: Pick<RateRow, "effectiveFrom">): string {
  return `from ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.effectiveFrom))}`
}

/**
 * Dimension prices are summarized by their keys; otherwise show the default price and its start.
 */
export function describeFeaturePrice(
  entry: FeaturePriceRows | undefined,
  currency: string,
  unit: string
): string {
  if (entry && entry.byDimension.length > 0) {
    const keys = new Set(entry.byDimension.flatMap((row) => Object.keys(row.match)))
    return `${entry.byDimension.length} prices by ${[...keys].join(", ")}`
  }
  if (entry?.current) return describeRatePrice(entry.current.price, currency, unit)
  if (entry?.scheduled) {
    return `${describeRatePrice(entry.scheduled.price, currency, unit)} ${scheduledFrom(entry.scheduled)}`
  }
  return "Not priced"
}

/** The singular spelling used after a unit rate. */
export function singularUnit(unit: string): string {
  return unit.replace(/s$/, "")
}

type PlanFeature = Pick<
  PlanVersionExtended["planFeatures"][number],
  "featureType" | "unitOfMeasure" | "included" | "limit" | "defaultQuantity" | "resetConfig"
> & { feature: { title: string } }

const GENERIC_UNITS = new Set(["", "unit", "units"])
const ZERO = BigInt(0)
const count = new Intl.NumberFormat("en")

/** "a day", "a month", "every 2 weeks": how often a limit resets, from the feature's reset config. */
function cadence(resetConfig: PlanFeature["resetConfig"]): string {
  if (!resetConfig) return ""
  const n = resetConfig.resetIntervalCount ?? 1
  const interval = resetConfig.resetInterval
  if (interval === "onetime") return ""
  return n === 1 ? ` a ${interval}` : ` every ${n} ${interval}s`
}

/** The units a graduated row gives away: the end of its leading tiers that cost nothing. */
function includedByTiers(price: Extract<RatePrice, { type: "graduated" }>): number {
  let included = 0
  for (const tier of price.tiers) {
    if (tier.rate > ZERO || tier.flat > ZERO || tier.upTo === null) break
    included = tier.upTo
  }
  return included
}

/** The unit price charged past what is included: the first tier that costs, or the row's rate. */
function unitRate(price: RatePrice): bigint {
  switch (price.type) {
    case "flat":
      return price.amount
    case "unit":
      return price.components[0]?.rate ?? ZERO
    case "package":
      return price.rate
    case "graduated":
      return price.tiers.find((tier) => tier.rate > ZERO)?.rate ?? ZERO
  }
}

/**
 * One line of a pricing card: what a customer gets and what more of it costs, such as
 * "3 seats included, then $10 per seat" or "Up to 50 images a day". A feature the card says
 * nothing about beyond access is "Unlimited"; a feature priced by a dimension says so.
 */
export function describePlanFeatureLine(
  feature: PlanFeature,
  rows: FeaturePriceRows | undefined,
  currency: string
): string {
  const title = feature.feature.title
  if (feature.featureType === "flat") return title

  const dimensions = new Set(rows?.byDimension.flatMap((row) => Object.keys(row.match)) ?? [])
  if (dimensions.size > 0) return `${title}, priced per ${[...dimensions].join(", ")}`

  const row = rows?.current ?? rows?.scheduled ?? null
  const unit = singularUnit((feature.unitOfMeasure ?? "").trim())
  const generic = GENERIC_UNITS.has(unit)
  const one = generic ? "unit" : unit
  const many = generic ? "units" : `${unit}s`

  const included =
    row?.price.type === "graduated"
      ? includedByTiers(row.price)
      : Math.max(0, Number(feature.included ?? 0))
  const rate = row ? unitRate(row.price) : ZERO
  const quantity = feature.defaultQuantity ?? 1

  const parts: string[] = []
  if (included > 0) parts.push(`${count.format(included)} ${many} included`)
  if (rate > ZERO) {
    const price = formatRateAmount(rate, currency)
    if (row?.price.type === "package") {
      parts.push(`${price} per ${count.format(row.price.size)} ${many}`)
    } else if (included > 0) {
      parts.push(`then ${price} per ${one}`)
    } else if (feature.featureType === "tier" && quantity > 1) {
      parts.push(`${count.format(quantity)} ${many} at ${price} per ${one}`)
    } else {
      parts.push(`${price} per ${one}`)
    }
  }
  if (feature.limit) {
    const limit = count.format(feature.limit)
    parts.push(
      parts.length > 0
        ? `up to ${limit}${cadence(feature.resetConfig)}`
        : `up to ${limit} ${many}${cadence(feature.resetConfig)}`
    )
  }

  if (parts.length === 0) return `Unlimited ${title}`
  const line = parts.join(", ")
  const sentence = line.charAt(0).toUpperCase() + line.slice(1)
  return generic ? `${title}: ${line}` : sentence
}

/**
 * How a feature is charged, in words beside its price, so "$49" reads as "Fixed, monthly".
 * The price sheet knows rates; the package (fixed, tiered, metered, a bundle) knows what they mean.
 */
export function describePlanFeatureCharge(
  planFeature: Pick<
    PlanVersionExtended["planFeatures"][number],
    "billingConfig" | "featureType" | "config" | "included"
  >,
  units: string
): string {
  const cycle = planFeature.billingConfig.name
  const unit = singularUnit(units)
  switch (planFeature.featureType) {
    case "flat":
      return `Fixed, ${cycle}`
    case "tier":
      return `Per ${unit} picked at signup, ${cycle}`
    case "package":
      return `Bundles of ${planFeature.config?.units ?? 1} ${units}, ${cycle}`
    case "usage": {
      const included = Number(planFeature.included ?? 0)
      const mode = planFeature.config?.usageMode
      const how =
        mode === "tier"
          ? `Metered per ${unit}, tiered`
          : mode === "package"
            ? `Metered in bundles of ${planFeature.config?.units ?? 1}`
            : `Metered per ${unit}`
      return included > 0 ? `${how}, first ${included.toLocaleString("en")} free` : how
    }
    default:
      return cycle
  }
}

type GraduatedPrice = Extract<RatePrice, { type: "graduated" }>

/**
 * Tiers in one line: "3 included, then $10 / seat" for a free tier followed by one rate; every
 * tier's range and price otherwise.
 */
export function tierSummary(price: GraduatedPrice, currency: string, unit: string): string {
  const lines = describeTiers(price, currency, unit)
  const [free, rest] = price.tiers
  const zero = BigInt(0)
  if (
    price.tiers.length === 2 &&
    free &&
    rest &&
    free.upTo !== null &&
    free.rate === zero &&
    free.flat === zero &&
    rest.flat === zero &&
    lines[1]
  ) {
    return `${new Intl.NumberFormat("en").format(free.upTo)} included, then ${lines[1].value}`
  }
  return lines.map((line) => `${line.label} at ${line.value}`).join(", ")
}
