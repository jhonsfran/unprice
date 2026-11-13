/**
 * Usage as a vector (ADR-0008 D1): the amount every consumption carries, and a quantity per
 * feature. One counter, one hold, and one row carry the whole vector; a limit reads one measure.
 */

import type { BudgetMeasure } from "@unprice/db/validators"
import type { Amount, SignedAmount } from "@unprice/money"
import { ownProperty } from "../pricing/resolve"

export type { BudgetMeasure }

/**
 * Amounts at the ledger scale. Canonical form: `quantities` never holds a zero entry, so two equal
 * vectors are structurally equal. A delta between vectors uses the same shape with signed values.
 */
export type Usage = Readonly<{ amount: Amount; quantities: Readonly<Record<string, Amount>> }>

const ZERO = BigInt(0)

export const NO_USAGE: Usage = { amount: ZERO, quantities: {} }

export const AMOUNT_MEASURE: BudgetMeasure = { type: "amount" }

/** Usage of the amount alone, as a lease or an amount-only caller reports it. */
export function amountUsage(amount: Amount): Usage {
  return { amount, quantities: {} }
}

/**
 * A feature's quantity in a vector. Feature slugs are caller data, so only own entries count: a
 * slug like `constructor` reads 0, not Object's.
 */
function quantityIn(quantities: Readonly<Record<string, Amount>>, feature: string): Amount {
  return ownProperty(quantities, feature) ?? ZERO
}

/** The canonical vector: zero quantities dropped, features in key order. */
export function usageOf(amount: Amount, quantities: Readonly<Record<string, Amount>> = {}): Usage {
  const kept = Object.keys(quantities)
    .sort()
    .flatMap((feature) => {
      const quantity = quantityIn(quantities, feature)
      return quantity === ZERO ? [] : [[feature, quantity] as const]
    })
  // fromEntries defines own properties, so a `__proto__` slug is a key, not the prototype.
  return { amount, quantities: Object.fromEntries(kept) }
}

function combine(a: Usage, b: Usage, sign: bigint): Usage {
  if (isNoUsage(b)) return a
  // Without a prototype, `__proto__` and `constructor` are plain keys.
  const quantities: Record<string, Amount> = Object.assign(Object.create(null), a.quantities)
  for (const [feature, quantity] of Object.entries(b.quantities)) {
    quantities[feature] = (quantities[feature] ?? ZERO) + sign * quantity
  }
  return usageOf(a.amount + sign * b.amount, quantities)
}

export function addUsage(a: Usage, b: Usage): Usage {
  return combine(a, b, BigInt(1))
}

export function subtractUsage(a: Usage, b: Usage): Usage {
  return combine(a, b, BigInt(-1))
}

export function isNoUsage(usage: Usage): boolean {
  return usage.amount === ZERO && Object.keys(usage.quantities).length === 0
}

/** What `usage` counts on one measure. */
export function measured(usage: Usage, measure: BudgetMeasure): SignedAmount {
  return measure.type === "amount" ? usage.amount : quantityIn(usage.quantities, measure.feature)
}

/** The measures either vector counts: the amount, then each feature in key order. */
function measuresOf(a: Usage, b: Usage): BudgetMeasure[] {
  const features = [...new Set([...Object.keys(a.quantities), ...Object.keys(b.quantities)])]
  return [
    AMOUNT_MEASURE,
    ...features.sort().map((feature): BudgetMeasure => ({ type: "quantity", feature })),
  ]
}

/** Equal on every measure, whether or not either vector is canonical. */
export function sameUsage(a: Usage, b: Usage): boolean {
  return measuresOf(a, b).every((measure) => measured(a, measure) === measured(b, measure))
}

/** The first measure on which `usage` exceeds `maximum`; null when it fits on every one. */
export function exceededMeasure(usage: Usage, maximum: Usage): BudgetMeasure | null {
  return (
    measuresOf(usage, maximum).find(
      (measure) => measured(usage, measure) > measured(maximum, measure)
    ) ?? null
  )
}

/** The first measure below zero; null when none is. */
export function negativeMeasure(usage: Usage): BudgetMeasure | null {
  return exceededMeasure(NO_USAGE, usage)
}

export function sameMeasure(a: BudgetMeasure, b: BudgetMeasure): boolean {
  return measureName(a) === measureName(b) && a.type === b.type
}

/** `amount`, or the feature's slug: how a message names a measure. */
export function measureName(measure: BudgetMeasure): string {
  return measure.type === "amount" ? "amount" : measure.feature
}
