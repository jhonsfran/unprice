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

/**
 * The bound of a curve on which `quantity` costs the most from position 0: linear prices and
 * packages, where a rounded difference never exceeds the exact cost from 0 rounded up.
 */
function ceilOf(curve: Curve): Bound {
  return (quantity) => {
    const exact = curve(quantity)
    return ceilDiv(exact.n, exact.d)
  }
}

const zeroCurve: Curve = () => rational(ZERO)
const zeroCost = { curve: zeroCurve, bound: ceilOf(zeroCurve) }

function unitCurve(component: RateComponent): Curve {
  const d = BigInt(component.per) * ONE
  return (quantity) => rational(component.rate * quantity, d)
}

/** Where a graduated tier starts, and the price numerator of every tier before it, flats included. */
type TierStart = Readonly<{ start: Amount; before: bigint; rate: Amount; flat: bigint }>

/**
 * Tier quantities at the tier rates, plus each entered tier's flat, over one denominator. Tier
 * starts and the sums before them are computed once, so pricing a quantity is a binary search.
 */
function graduatedCurve(price: Extract<RatePrice, { type: "graduated" }>): Curve {
  const d = BigInt(price.per) * ONE
  const tiers: TierStart[] = []
  let start = ZERO
  let before = ZERO
  for (const tier of price.tiers) {
    const flat = tier.flat * d
    tiers.push({ start, before, rate: tier.rate, flat })
    if (tier.upTo === null) break
    const end = BigInt(tier.upTo) * ONE
    before += (end - start) * tier.rate + flat
    start = end
  }
  return (quantity) => {
    // The last tier whose start the quantity has passed; usage enters a tier just past its start.
    let low = 0
    let high = tiers.length - 1
    let entered: TierStart | undefined
    while (low <= high) {
      const middle = (low + high) >> 1
      const tier = tiers[middle]
      if (tier && tier.start < quantity) {
        entered = tier
        low = middle + 1
      } else high = middle - 1
    }
    if (!entered) return rational(ZERO, d)
    return rational(entered.before + entered.flat + (quantity - entered.start) * entered.rate, d)
  }
}

/**
 * Graduated prices are piecewise linear with a jump (the flat) just past each tier start, so the
 * cost of `quantity` from position y is linear between the points where y or y + quantity meets a
 * boundary. Its maximum is at one of them, or at 0. Included units only shift the curve right.
 */
function graduatedBound(price: Extract<RatePrice, { type: "graduated" }>, curve: Curve): Bound {
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

function usageLines(row: RateRow, meterProperty: string | null): readonly UsageLine[] {
  const costOf = (property: string | null) => {
    if (row.cost === null) return null
    const component = row.cost.components.find((c) => c.property === property)
    if (!component) return zeroCost
    const curve = unitCurve(component)
    return { curve, bound: ceilOf(curve) }
  }
  const line = (property: string | null, price: Curve, bound: Bound, included: boolean) => ({
    property,
    price,
    bound,
    cost: costOf(property),
    included,
  })
  const price = row.price
  switch (price.type) {
    case "unit":
      return price.components.map((component) => {
        const curve = unitCurve(component)
        const included = price.components.length === 1 && component.property === meterProperty
        return line(component.property, curve, ceilOf(curve), included)
      })
    case "graduated": {
      const curve = graduatedCurve(price)
      const bound = graduatedBound(price, curve)
      return [line(price.property, curve, bound, price.property === meterProperty)]
    }
    case "package": {
      const curve = packageCurve(price)
      return [line(price.property, curve, ceilOf(curve), price.property === meterProperty)]
    }
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
