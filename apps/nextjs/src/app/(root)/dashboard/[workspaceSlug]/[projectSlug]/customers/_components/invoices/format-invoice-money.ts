import {
  formatMoney,
  fromCurrencyMinor,
  fromLedgerMinor,
  toCurrencyMinor,
  toDecimal,
} from "@unprice/money"

const INVOICE_MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

function toInvoiceCurrencyMinor(amount: number, currency: string): number {
  return toCurrencyMinor(fromLedgerMinor(amount, currency))
}

function formatInvoiceCurrencyMinor(amount: number, currency: string): string {
  return formatMoney(
    toDecimal(fromCurrencyMinor(amount, currency)),
    currency,
    INVOICE_MONEY_DISPLAY_OPTIONS
  )
}

export function formatInvoiceMoney(amount: number, currency: string): string {
  return formatInvoiceCurrencyMinor(toInvoiceCurrencyMinor(amount, currency), currency)
}
