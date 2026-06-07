import {
  formatMoney,
  fromCurrencyMinor,
  fromLedgerMinor,
  toCurrencyMinor,
  toDecimal,
} from "@unprice/money"

function toInvoiceCurrencyMinor(amount: number, currency: string): number {
  return toCurrencyMinor(fromLedgerMinor(amount, currency))
}

function formatInvoiceCurrencyMinor(amount: number, currency: string): string {
  return formatMoney(toDecimal(fromCurrencyMinor(amount, currency)), currency)
}

export function formatInvoiceMoney(amount: number, currency: string): string {
  return formatInvoiceCurrencyMinor(toInvoiceCurrencyMinor(amount, currency), currency)
}
