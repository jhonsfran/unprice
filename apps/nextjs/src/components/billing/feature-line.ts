import type { PlanVersionExtended, RatePrice, RateRow } from "@unprice/db/validators"
import { formatRateAmount } from "@unprice/services/pricing"

/** The rows a pricing card reads for one feature; the shape `rowsByFeature` builds in the plan editor. */
export type FeatureLineRows = Readonly<{
  current: RateRow | null
  scheduled: RateRow | null
  byDimension: readonly RateRow[]
}>

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
export function describeFeatureLine(
  feature: PlanFeature,
  rows: FeatureLineRows | undefined,
  currency: string
): string {
  const title = feature.feature.title
  if (feature.featureType === "flat") return title

  const dimensions = new Set(rows?.byDimension.flatMap((row) => Object.keys(row.match)) ?? [])
  if (dimensions.size > 0) return `${title}, priced per ${[...dimensions].join(", ")}`

  const row = rows?.current ?? rows?.scheduled ?? null
  const unit = (feature.unitOfMeasure ?? "").trim().replace(/s$/, "")
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
