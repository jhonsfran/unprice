import {
  formatMoney,
  fromCurrencyMinor,
  fromLedgerMinor,
  toCurrencyMinor,
  toDecimal,
} from "@unprice/money"

const RUN_MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

export function formatRunMoney(amount: number, currency: string): string {
  const currencyMinor = toCurrencyMinor(fromLedgerMinor(amount, currency))
  return formatMoney(
    toDecimal(fromCurrencyMinor(currencyMinor, currency)),
    currency,
    RUN_MONEY_DISPLAY_OPTIONS
  )
}
