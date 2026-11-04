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
import { ownProperty, resolveRow } from "./resolve"

/** The exact price of a cumulative quantity, before its one rounding. */
type Curve = (quantity: Amount) => Rational

/**
 * The most `quantity` more can cost on a curve, starting from any position, after rounding: what a
 * hold reserves, so no settle or concurrent hold can make the same usage cost more.
 */
type Bound = (quantity: Amount) => Amount

/** One position a usage row prices: a price curve, an optional cost curve, and its allowance. */
type UsageLine = Readonly<{
  property: string | null
  price: Curve
  bound: Bound
  cost: Readonly<{ curve: Curve; bound: Bound }> | null
  /** Whether the feature's `included` units come off this position before pricing. */
  included: boolean
}>

const zeroCost = { curve: (() => rational(ZERO)) as Curve, bound: (() => ZERO) as Bound }

function unitCurve(component: RateComponent): Curve {
  const d = BigInt(component.per) * ONE
  return (quantity) => rational(component.rate * quantity, d)
}

/** Linear: a rounded difference never exceeds the exact one rounded up. */
function unitBound(component: RateComponent): Bound {
  const d = BigInt(component.per) * ONE
  return (quantity) => ceilDiv(component.rate * quantity, d)
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

/**
 * Graduated prices are piecewise linear with a jump (the flat) just past each tier start, so the
 * cost of `quantity` from position y is linear between the points where y or y + quantity meets a
 * boundary. Its maximum is at one of them, or at 0. Included units only shift the curve right.
 */
function graduatedBound(price: Extract<RatePrice, { type: "graduated" }>): Bound {
  const curve = graduatedCurve(price)
  const step = BigInt(1)
  const starts = price.tiers.flatMap((tier) =>
    tier.upTo === null ? [] : [BigInt(tier.upTo) * ONE]
  )
  return (quantity) => {
    let most = ZERO
    const points = [
      ZERO,
      ...starts.flatMap((b) => [b - quantity, b - quantity + step, b, b + step]),
    ]
    for (const y of points) {
      if (y < ZERO) continue
      const cost = curve(y + quantity).n - curve(y).n
      if (cost > most) most = cost
    }
    return ceilDiv(most, BigInt(price.per) * ONE)
  }
}

/** A started package counts as a whole one. */
function packageCurve(price: Extract<RatePrice, { type: "package" }>): Curve {
  const size = BigInt(price.size) * ONE
  return (quantity) => rational(ceilDiv(quantity, size) * price.rate)
}

/** At most one package per started `size` units, however the units straddle packages. */
function packageBound(price: Extract<RatePrice, { type: "package" }>): Bound {
  const size = BigInt(price.size) * ONE
  return (quantity) => ceilDiv(quantity, size) * price.rate
}

function usageLines(row: RateRow, meterProperty: string | null): readonly UsageLine[] {
  const costOf = (property: string | null) => {
    if (row.cost === null) return null
    const component = row.cost.components.find((c) => c.property === property)
    return component ? { curve: unitCurve(component), bound: unitBound(component) } : zeroCost
  }
  const price = row.price
  switch (price.type) {
    case "unit":
      return price.components.map((component) => ({
        property: component.property,
        price: unitCurve(component),
        bound: unitBound(component),
        cost: costOf(component.property),
        included: price.components.length === 1 && component.property === meterProperty,
      }))
    case "graduated":
      return [
        {
          property: price.property,
          price: graduatedCurve(price),
          bound: graduatedBound(price),
          cost: costOf(price.property),
          included: price.property === meterProperty,
        },
      ]
    case "package":
      return [
        {
          property: price.property,
          price: packageCurve(price),
          bound: packageBound(price),
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

/**
 * The quantity an event carries for `property`: one for null, 0 when the event lacks it. Only
 * the event's own properties count, so `constructor` or `toString` never reads Object.prototype.
 */
export function quantityOf(
  properties: Readonly<Record<string, unknown>>,
  property: string | null
): Result<Amount, UnPricePricingError> {
  if (property === null) return Ok(ONE)
  const parsed = parseQuantity(ownProperty(properties, property))
  if (parsed.ok) return Ok(parsed.quantity)
  return Err(new UnPricePricingError({ code: "INVALID_USAGE", property, reason: parsed.reason }))
}

/**
 * Prices one event against the cumulative positions it moves. Pure: the caller stores each
 * line's `after` as the new position.
 */
export function priceUsage(input: PriceUsageInput): Result<PricedUsage, UnPricePricingError> {
  const included = input.feature.included ?? ZERO
  return pricedLines(input, (line, before, after) => {
    const billable = (total: Amount) => (line.included ? maxAmount(ZERO, total - included) : total)
    return {
      amount: delta(line.price, billable(before), billable(after)),
      cost: line.cost === null ? null : delta(line.cost.curve, before, after),
    }
  })
}

/**
 * The most the event can cost from any position: what a hold reserves. Positions do not move, so
 * concurrent holds never share an allowance or a cheap tier, and a settle within the estimate's
 * quantities, priced where the positions stand then, costs no more than the estimate.
 */
export function estimateUsage(input: PriceUsageInput): Result<PricedUsage, UnPricePricingError> {
  return pricedLines(input, (line, before, after) => ({
    amount: line.bound(after - before),
    cost: line.cost === null ? null : line.cost.bound(after - before),
  }))
}

function pricedLines(
  input: PriceUsageInput,
  priced: (
    line: UsageLine,
    before: Amount,
    after: Amount
  ) => Readonly<{ amount: Amount; cost: Amount | null }>
): Result<PricedUsage, UnPricePricingError> {
  const { feature, properties, positionOf } = input
  const resolved = resolveRow(input.cards, feature, properties, input.at)
  if (resolved.err) return resolved
  const { card, row } = resolved.val

  const meter = quantityOf(properties, feature.meterProperty)
  if (meter.err) return meter

  const rowMatchKey = matchKey(row.match)
  const usage = usageLines(row, feature.meterProperty)
  const included = feature.included ?? ZERO
  if (included > ZERO && (rowMatchKey !== "" || !usage.some((line) => line.included))) {
    const rejection = {
      code: "INCLUDED_NOT_APPLICABLE",
      feature: feature.slug,
      rowId: row.id,
    } as const
    return Err(new UnPricePricingError(rejection))
  }
  const lines: PricedLine[] = []
  for (const line of usage) {
    const quantity = quantityOf(properties, line.property)
    if (quantity.err) return quantity
    const key = positionKey(feature.slug, rowMatchKey, line.property)
    const before = positionOf(key)
    const after = before + quantity.val
    lines.push({
      positionKey: key,
      property: line.property,
      before,
      after,
      ...priced(line, before, after),
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
