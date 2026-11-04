import type { RateComponent, RatePrice, RateRow } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Amount } from "@unprice/money"
import {
  ONE,
  type Rational,
  ZERO,
  addRational,
  ceilDiv,
  maxAmount,
  minAmount,
  parseQuantity,
  rational,
  roundHalfUp,
} from "./decimal"
import {
  type PriceUsageInput,
  type PricedLine,
  type PricedUsage,
  UnPricePricingError,
  matchKey,
  positionKey,
} from "./model"
import { resolveRow } from "./resolve"

/** The exact price of a cumulative quantity, before its one rounding. */
type Curve = (quantity: Amount) => Rational

/** One position a usage row prices: a price curve, an optional cost curve, and its allowance. */
type UsageLine = Readonly<{
  property: string | null
  price: Curve
  cost: Curve | null
  /** Whether the feature's `included` units come off this position before pricing. */
  included: boolean
}>

const zeroCurve: Curve = () => rational(ZERO)

function unitCurve(component: RateComponent): Curve {
  const d = BigInt(component.per) * ONE
  return (quantity) => rational(component.rate * quantity, d)
}

/** Tier quantities at the tier rates, plus each entered tier's flat, over one denominator. */
function graduatedCurve(price: Extract<RatePrice, { type: "graduated" }>): Curve {
  const d = BigInt(price.per) * ONE
  return (quantity) => {
    let n = ZERO
    let start = ZERO
    for (const tier of price.tiers) {
      if (quantity <= start) break
      const end = tier.upTo === null ? quantity : minAmount(quantity, BigInt(tier.upTo) * ONE)
      n += (end - start) * tier.rate + tier.flat * d
      if (tier.upTo === null) break
      start = BigInt(tier.upTo) * ONE
    }
    return rational(n, d)
  }
}

/** A started package counts as a whole one. */
function packageCurve(price: Extract<RatePrice, { type: "package" }>): Curve {
  const size = BigInt(price.size) * ONE
  return (quantity) => rational(ceilDiv(quantity, size) * price.rate)
}

function usageLines(row: RateRow, meterProperty: string | null): readonly UsageLine[] {
  const costOf = (property: string | null): Curve | null => {
    if (row.cost === null) return null
    const component = row.cost.components.find((c) => c.property === property)
    return component ? unitCurve(component) : zeroCurve
  }
  const price = row.price
  switch (price.type) {
    case "unit":
      return price.components.map((component) => ({
        property: component.property,
        price: unitCurve(component),
        cost: costOf(component.property),
        included: price.components.length === 1 && component.property === meterProperty,
      }))
    case "graduated":
    case "package":
      return [
        {
          property: price.property,
          price: price.type === "graduated" ? graduatedCurve(price) : packageCurve(price),
          cost: costOf(price.property),
          included: price.property === meterProperty,
        },
      ]
    case "flat":
      return []
  }
}

/** Rounded once per position: the delta of the rounded cumulative prices. */
function delta(curve: Curve, before: Amount, after: Amount): Amount {
  return roundHalfUp(curve(after)) - roundHalfUp(curve(before))
}

function quantityOf(
  properties: Readonly<Record<string, unknown>>,
  property: string | null
): Result<Amount, UnPricePricingError> {
  if (property === null) return Ok(ONE)
  const parsed = parseQuantity(properties[property])
  if (parsed.ok) return Ok(parsed.quantity)
  return Err(new UnPricePricingError({ code: "INVALID_USAGE", property, reason: parsed.reason }))
}

/**
 * Prices one event against the cumulative positions it moves. Pure: the caller stores each
 * line's `after` as the new position.
 */
export function priceUsage(input: PriceUsageInput): Result<PricedUsage, UnPricePricingError> {
  const { feature, properties, positionOf } = input
  const resolved = resolveRow(input.cards, feature, properties, input.at)
  if (resolved.err) return resolved
  const { card, row } = resolved.val

  const meter = quantityOf(properties, feature.meterProperty)
  if (meter.err) return meter

  const included = feature.included ?? ZERO
  const rowMatchKey = matchKey(row.match)
  const lines: PricedLine[] = []
  for (const line of usageLines(row, feature.meterProperty)) {
    const quantity = quantityOf(properties, line.property)
    if (quantity.err) return quantity
    const key = positionKey(feature.slug, rowMatchKey, line.property)
    const before = positionOf(key)
    const after = before + quantity.val
    const billable = (total: Amount) => (line.included ? maxAmount(ZERO, total - included) : total)
    lines.push({
      positionKey: key,
      property: line.property,
      before,
      after,
      amount: delta(line.price, billable(before), billable(after)),
      cost: line.cost && delta(line.cost, before, after),
    })
  }

  return Ok({
    cardId: card.id,
    rowId: row.id,
    lines,
    amount: lines.reduce((sum, line) => sum + line.amount, ZERO),
    cost: row.cost === null ? null : lines.reduce((sum, line) => sum + (line.cost ?? ZERO), ZERO),
    meterQuantity: meter.val,
  })
}

/** A recurring item (seats, a base fee) priced on its total quantity at scale 8. */
export function priceQuantity(row: RateRow, quantity: Amount): Amount {
  const price = row.price
  switch (price.type) {
    case "unit":
      return roundHalfUp(
        price.components
          .map((component) => unitCurve(component)(quantity))
          .reduce(addRational, rational(ZERO))
      )
    case "graduated":
      return roundHalfUp(graduatedCurve(price)(quantity))
    case "package":
      return roundHalfUp(packageCurve(price)(quantity))
    case "flat":
      return price.amount
  }
}
