/**
 * Exact decimal arithmetic for pricing. Every value is a bigint at LEDGER_SCALE; a price is an
 * exact rational until it is rounded once, half up, back to scale 8.
 */

import { AMOUNT_ONE, type Amount, LEDGER_SCALE, parseAmount } from "@unprice/money"

export const ZERO = BigInt(0)
export const ONE = AMOUNT_ONE

/** A non-negative exact value at scale 8: `n / d` base units, `d > 0`. */
export type Rational = Readonly<{ n: bigint; d: bigint }>

export function rational(n: bigint, d: bigint = BigInt(1)): Rational {
  return { n, d }
}

export function addRational(a: Rational, b: Rational): Rational {
  if (a.d === b.d) return { n: a.n + b.n, d: a.d }
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d }
}

export function roundHalfUp(value: Rational): Amount {
  const two = BigInt(2)
  return (two * value.n + value.d) / (two * value.d)
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - BigInt(1)) / d
}

export function minAmount(a: Amount, b: Amount): Amount {
  return a < b ? a : b
}

export function maxAmount(a: Amount, b: Amount): Amount {
  return a > b ? a : b
}

export type QuantityParse =
  | Readonly<{ ok: true; quantity: Amount }>
  | Readonly<{ ok: false; reason: string }>

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/
const EXPONENT_NUMBER = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/

/**
 * An event property as a quantity at scale 8, without float math: a number goes through its
 * shortest round-trip string. A missing (undefined or null) property is 0.
 */
export function parseQuantity(value: unknown): QuantityParse {
  if (value === undefined || value === null) return { ok: true, quantity: ZERO }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "not a finite number" }
    if (value < 0) return { ok: false, reason: "negative" }
    return parseDecimal(plainDecimal(String(value)))
  }
  if (typeof value === "string") {
    if (value.startsWith("-")) return { ok: false, reason: "negative" }
    return parseDecimal(value)
  }
  return { ok: false, reason: "not a number or numeric string" }
}

function parseDecimal(text: string): QuantityParse {
  const match = PLAIN_DECIMAL.exec(text)
  if (!match) return { ok: false, reason: "not a decimal number" }
  const whole = (match[1] ?? "").replace(/^0+(?=\d)/, "")
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  if (fraction.length > LEDGER_SCALE) {
    return { ok: false, reason: `more than ${LEDGER_SCALE} decimal places` }
  }
  const parsed = parseAmount(fraction ? `${whole}.${fraction}` : whole)
  if (!parsed.ok) return { ok: false, reason: "too large" }
  return { ok: true, quantity: parsed.amount }
}

/** "1.5e-7" -> "0.00000015", "1e+21" -> "1000000000000000000000". */
function plainDecimal(text: string): string {
  const match = EXPONENT_NUMBER.exec(text)
  if (!match) return text
  const whole = match[1] ?? ""
  const digits = whole + (match[2] ?? "")
  const point = whole.length + Number(match[3])
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return digits + "0".repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}
