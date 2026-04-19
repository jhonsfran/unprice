import {
  type Dinero,
  add,
  dinero,
  isZero,
  multiply,
  subtract,
  toDecimal,
  toSnapshot,
  transformScale,
  up,
} from "dinero.js"
import * as currencies from "dinero.js/currencies"

type DineroCurrency = (typeof currencies)[keyof typeof currencies]

/**
 * Single internal scale for every precise money value: pgledger storage,
 * per-event priced amounts flushed to analytics, and any intermediate
 * computation that must preserve sub-cent precision (e.g. $0.000003/token).
 *
 * Quantization to currency minor units (cents) happens only at external
 * boundaries — Stripe, invoice line items, display — via
 * `formatAmountForProvider`.
 *
 * Changing this value is a data-model break: existing ledger entries,
 * persisted outbox payloads, and Tinybird rows all interpret `amount` at
 * this scale. Treat as a constant, not a configuration knob.
 */
export const LEDGER_SCALE = 8

/**
 * The set of currencies the money layer understands at runtime. Adding a
 * currency here is the only place you need to touch to support it across
 * ledger, pricing, and invoicing.
 */
const DINERO_CURRENCY: Record<string, DineroCurrency> = {
  USD: currencies.USD,
  EUR: currencies.EUR,
}

export type MoneyCurrency = keyof typeof DINERO_CURRENCY

export { add, currencies, type Dinero, dinero, isZero, multiply, subtract, toDecimal, toSnapshot }

function resolveCurrency(code: string): DineroCurrency {
  const currency = DINERO_CURRENCY[code]
  if (!currency) {
    throw new Error(`Unsupported currency: ${code}`)
  }
  return currency
}

/**
 * Serialize a `Dinero<number>` as a decimal string at `LEDGER_SCALE` — the
 * wire format for pgledger's numeric column. Guarantees every stored amount
 * carries the same precision regardless of the caller's input scale.
 */
export function toLedgerAmount(amount: Dinero<number>): string {
  const scaled = transformScale(amount, LEDGER_SCALE, up)
  return toDecimal(scaled)
}

/**
 * Reconstruct a `Dinero<number>` at `LEDGER_SCALE` from the decimal string
 * returned by pgledger (or any caller that stores via `toLedgerAmount`).
 */
export function fromLedgerAmount(value: string, currency: string): Dinero<number> {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [intPart, fracPart = ""] = unsigned.split(".")

  const fracTrimmed = fracPart.slice(0, LEDGER_SCALE)
  const fracPadded = fracTrimmed.padEnd(LEDGER_SCALE, "0")

  const minorString = `${intPart}${fracPadded}`.replace(/^0+(?=\d)/, "") || "0"
  const minor = Number(minorString) * (negative ? -1 : 1)

  return dinero({
    amount: minor,
    currency: resolveCurrency(currency),
    scale: LEDGER_SCALE,
  })
}

/**
 * Extract the ledger-scale minor-unit integer as a plain `number`. At scale
 * 8, `$0.00000032` → `32`. `Number.MAX_SAFE_INTEGER` at scale 8 covers per-
 * event amounts up to ~$90M before integer precision breaks — comfortably
 * beyond any plausible per-event delta, with several decimals of headroom
 * below realistic LLM token prices (~$10⁻⁵/token).
 *
 * Note: accumulating across *all* events of a very high-throughput customer
 * can still approach the safe-integer limit if you never flush. If that
 * becomes a concern, sum incrementally and reset per flush window rather
 * than widening to bigint here.
 */
export function toLedgerMinor(amount: Dinero<number>): number {
  const scaled = transformScale(amount, LEDGER_SCALE, up)
  return toSnapshot(scaled).amount
}

/**
 * Rebuild a `Dinero<number>` from a ledger-scale number. Inverse of
 * `toLedgerMinor`.
 */
export function fromLedgerMinor(minor: number, currency: string): Dinero<number> {
  return dinero({
    amount: minor,
    currency: resolveCurrency(currency),
    scale: LEDGER_SCALE,
  })
}

/**
 * Precise subtraction at `LEDGER_SCALE`, returning a signed number of minor
 * units. This is the correct primitive for "price delta of this event" —
 * compute `price(usageAfter) - price(usageBefore)` without prematurely
 * quantizing to cents.
 *
 * Unlike `formatAmountForProvider`, this does NOT clamp to non-negative.
 * Corrections/refunds legitimately produce negative deltas; clamping belongs
 * at invoicing, not here.
 */
export function diffLedgerMinor(after: Dinero<number>, before: Dinero<number>): number {
  return toLedgerMinor(after) - toLedgerMinor(before)
}

/**
 * Quantize a `Dinero<number>` to the currency's minor unit (e.g. cents for
 * USD/EUR) for handoff to external systems that only accept integer minor
 * units: Stripe, invoice line-item columns, user-facing display.
 *
 * This is the ONE seam where sub-cent precision is deliberately lost. Do not
 * use inside internal pricing math — use `toLedgerMinor` / `diffLedgerMinor`.
 */
export function formatAmountForProvider(price: Dinero<number>): {
  amount: number
  currency: string
} {
  const { currency } = toSnapshot(price)
  const scaled = transformScale(price, currency.exponent, up)
  const { amount } = toSnapshot(scaled)
  return { amount, currency: currency.code.toLowerCase() }
}

/**
 * Multiply a `Dinero<number>` by a fractional percentage in the [0, 1] range.
 * Percentages with a decimal part are lifted to an integer amount/scale pair
 * so Dinero's integer-only multiply can consume them without premature
 * rounding.
 */
export function calculatePercentage(price: Dinero<number>, percentage: number): Dinero<number> {
  if (percentage < 0 || percentage > 1) {
    throw new Error(`Percentage must be between 0 and 1, got ${percentage}`)
  }

  const str = percentage.toString()
  const scale = str.split(".")[1]?.length ?? 0
  const rest = percentage * 10 ** scale

  return multiply(price, { amount: Math.round(rest), scale })
}

/**
 * Format a decimal string as a localized currency string for display.
 * Rendering-only — never feed the result back into a pricing calculation.
 */
export function formatMoney(amount: string, currencyCode = "USD"): string {
  const userLocale = currencyCode === "USD" ? "en-US" : "es-ES"
  return new Intl.NumberFormat(userLocale, {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(Number.parseFloat(amount))
}

export function currencySymbol(currencyCode: string): string {
  return ({ USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[currencyCode] ?? currencyCode
}
