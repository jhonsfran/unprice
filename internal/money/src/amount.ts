/**
 * Single internal scale for every precise money value: pgledger storage,
 * per-event priced amounts flushed to analytics, and any intermediate
 * computation that must preserve sub-cent precision (e.g. $0.000003/token).
 *
 * Quantization to currency minor units (cents) happens only at external
 * boundaries. Provider handoff uses `formatAmountForProvider`; customer
 * display uses `toCurrencyMinor`.
 *
 * Changing this value is a data-model break: existing ledger entries,
 * persisted outbox payloads, and Tinybird rows all interpret `amount` at
 * this scale. Treat as a constant, not a configuration knob.
 */
export const LEDGER_SCALE = 8

/**
 * A decimal amount at LEDGER_SCALE as `bigint` base units. Plain numbers lose precision past
 * 2^53 base units (about 90M units), which a token budget reaches, and `bigint` cannot mix with
 * `number` at compile time, so an unparsed user number never reaches arithmetic. Every single
 * amount is capped at the int64 maximum so it fits a Postgres `bigint`; running sums are not.
 */
export type Amount = bigint

/** May be negative: a remaining balance after an overrun or a lowered limit. */
export type SignedAmount = bigint

export const AMOUNT_ONE = BigInt(10 ** LEDGER_SCALE)
export const AMOUNT_MAX = BigInt("9223372036854775807")

/** The wire form: a non-negative decimal with at most LEDGER_SCALE places. No sign, no exponent. */
export const AMOUNT_PATTERN = new RegExp(`^\\d{1,19}(\\.\\d{1,${LEDGER_SCALE}})?$`)

export type AmountParse =
  | Readonly<{ ok: true; amount: Amount }>
  | Readonly<{ ok: false; reason: "not_decimal" | "too_large" }>

/** Parses a wire decimal into base units without rounding. */
export function parseAmount(text: string): AmountParse {
  const match = AMOUNT_PATTERN.exec(text)
  if (!match) return { ok: false, reason: "not_decimal" }
  const [whole = "0", fraction = ""] = text.split(".")
  const amount = BigInt(whole) * AMOUNT_ONE + BigInt(fraction.padEnd(LEDGER_SCALE, "0"))
  if (amount > AMOUNT_MAX) return { ok: false, reason: "too_large" }
  return { ok: true, amount }
}

/** Canonical decimal: no trailing zeros, no exponent, "-" for negatives. */
export function formatAmount(amount: SignedAmount): string {
  const negative = amount < BigInt(0)
  const abs = negative ? -amount : amount
  const whole = (abs / AMOUNT_ONE).toString()
  const fraction = (abs % AMOUNT_ONE).toString().padStart(LEDGER_SCALE, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}
