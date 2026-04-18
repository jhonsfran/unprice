import * as currencies from "@dinero.js/currencies"
import type { Currency } from "@unprice/db/validators"
import { type Dinero, dinero, toDecimal, transformScale, up } from "dinero.js"

/**
 * Internal scale used for every value pgledger stores. 1 USD = 1.000000 at
 * scale 6, which preserves sub-cent precision (e.g. $0.000003 per token) and
 * matches what pgledger's `numeric` column round-trips losslessly.
 *
 * Module-private on purpose: the gateway is the only seam that needs to know
 * about the storage format. Callers pass and receive `Dinero<number>`.
 */
const LEDGER_INTERNAL_SCALE = 6

const DINERO_CURRENCY: Record<Currency, (typeof currencies)[keyof typeof currencies]> = {
  USD: currencies.USD,
  EUR: currencies.EUR,
}

/**
 * Serialize a `Dinero<number>` for storage in pgledger's numeric column.
 * Scales the value up to `LEDGER_INTERNAL_SCALE` first so every transfer
 * carries the same precision regardless of the caller's input scale.
 */
export function toLedgerAmount(amount: Dinero<number>): string {
  const scaled = transformScale(amount, LEDGER_INTERNAL_SCALE, up)
  return toDecimal(scaled)
}

/**
 * Reconstruct a `Dinero<number>` from pgledger's numeric column. Accepts the
 * decimal string pgledger returns and the account's currency code.
 */
export function fromLedgerAmount(value: string, currency: Currency): Dinero<number> {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [intPart, fracPart = ""] = unsigned.split(".")

  const fracTrimmed = fracPart.slice(0, LEDGER_INTERNAL_SCALE)
  const fracPadded = fracTrimmed.padEnd(LEDGER_INTERNAL_SCALE, "0")

  const minorString = `${intPart}${fracPadded}`.replace(/^0+(?=\d)/, "") || "0"
  const minor = Number(minorString) * (negative ? -1 : 1)

  return dinero({
    amount: minor,
    currency: DINERO_CURRENCY[currency],
    scale: LEDGER_INTERNAL_SCALE,
  })
}
