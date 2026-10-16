import { z } from "zod"

/**
 * Budget amounts are `bigint` base units at a fixed scale of 8 in the budget's unit (ADR-0006 B1).
 *
 * Plain numbers lose precision past 2^53 base units (about 90M units), which a token budget
 * reaches. `bigint` also cannot mix with `number` at compile time, so an unparsed user number can
 * never reach the core. Every single amount (a limit, an estimate, an actual) is capped at the
 * int64 maximum so it can be posted to Postgres `bigint` columns; running sums are unbounded.
 */
export const AMOUNT_SCALE = 8
export const AMOUNT_ONE = BigInt(100_000_000)
export const AMOUNT_MAX = BigInt("9223372036854775807")

/** Non-negative base units at scale 8. The only producer from user input is `parseAmount`. */
export type Amount = bigint

/** May be negative: `remaining` after an overrun, a late settle, or a lowered limit. */
export type SignedAmount = bigint

export type AmountParseError =
  | "not_decimal"
  | "negative"
  | "too_precise"
  | "too_large"
  | "not_finite"
  | "unsafe_number"

export type AmountParse =
  | Readonly<{ ok: true; amount: Amount }>
  | Readonly<{ ok: false; reason: AmountParseError }>

const DECIMAL = /^(\d+)(?:\.(\d+))?$/
const EXPONENT = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/

/**
 * Parses a wire amount into base units without any float rounding.
 * - string: `^\d+(\.\d+)?$`; more than 8 significant decimals is `too_precise`, never rounded.
 * - number: read through its shortest round-trip decimal (`String(n)`), so `0.1` is exactly 0.1
 *   and `0.1 + 0.2` is `too_precise`. Numbers above 2^53 are `unsafe_number`: they already lost
 *   digits before reaching us, so the caller must send a decimal string.
 */
export function parseAmount(input: string | number): AmountParse {
  let text: string
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, reason: "not_finite" }
    if (input < 0) return { ok: false, reason: "negative" }
    if (input > Number.MAX_SAFE_INTEGER) return { ok: false, reason: "unsafe_number" }
    text = expandExponent(String(input))
  } else {
    if (input.startsWith("-")) return { ok: false, reason: "negative" }
    text = input
  }

  const match = DECIMAL.exec(text)
  if (!match) return { ok: false, reason: "not_decimal" }
  const whole = match[1] ?? "0"
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  if (fraction.length > AMOUNT_SCALE) return { ok: false, reason: "too_precise" }

  const amount = BigInt(whole) * AMOUNT_ONE + BigInt(fraction.padEnd(AMOUNT_SCALE, "0"))
  if (amount > AMOUNT_MAX) return { ok: false, reason: "too_large" }
  return { ok: true, amount }
}

/** Canonical decimal: no trailing zeros, no exponent, "-" for negatives. */
export function formatAmount(amount: SignedAmount): string {
  const negative = amount < BigInt(0)
  const abs = negative ? -amount : amount
  const whole = (abs / AMOUNT_ONE).toString()
  const fraction = (abs % AMOUNT_ONE).toString().padStart(AMOUNT_SCALE, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}

/** Wire amount (decimal string or JSON number) to base units. */
export const amountSchema = z.union([z.string(), z.number(), z.nan()]).transform((input, ctx) => {
  const parsed = parseAmount(input)
  if (!parsed.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid amount: ${parsed.reason}` })
    return z.NEVER
  }
  return parsed.amount
})

/** `String(n)` uses exponent form below 1e-6; rewrite it as a plain decimal. */
function expandExponent(text: string): string {
  const match = EXPONENT.exec(text)
  if (!match) return text
  const whole = match[1] ?? ""
  const fraction = match[2] ?? ""
  const digits = whole + fraction
  const point = whole.length + Number(match[3])
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return digits + "0".repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}
