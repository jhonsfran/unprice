import type { Currency } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { type Dinero, isNegative, isZero, toSnapshot } from "dinero.js"
import { UnPriceLedgerError } from "./errors"

/**
 * Pure validators that gate every charge / refund call into the gateway.
 *
 * The legacy ledger had `decideDebit`/`decideCredit`/`foldLedgerState` that
 * computed running balances in TypeScript — pgledger now owns that math at
 * the SQL boundary, so the only thing left here is amount + currency
 * sanity-checking.
 */

/**
 * Charges and refunds must be strictly positive — pgledger's transfer
 * function rejects non-positive amounts at the SQL boundary, but failing
 * fast in the service layer keeps the error surface clean.
 */
export function assertPositiveAmount(
  amount: Dinero<number>
): Result<Dinero<number>, UnPriceLedgerError> {
  if (isZero(amount) || isNegative(amount)) {
    return Err(new UnPriceLedgerError({ message: "LEDGER_INVALID_AMOUNT" }))
  }
  return Ok(amount)
}

/**
 * The Dinero amount must match the target accounts' currency before we
 * compute a serialization. Avoids "0 USD = 0 EUR" footguns.
 */
export function assertCurrencyMatch(
  amount: Dinero<number>,
  currency: Currency
): Result<Dinero<number>, UnPriceLedgerError> {
  const code = toSnapshot(amount).currency.code
  if (code.toUpperCase() !== currency.toUpperCase()) {
    return Err(
      new UnPriceLedgerError({
        message: "LEDGER_CURRENCY_MISMATCH",
        context: { amountCurrency: code, expected: currency },
      })
    )
  }
  return Ok(amount)
}
