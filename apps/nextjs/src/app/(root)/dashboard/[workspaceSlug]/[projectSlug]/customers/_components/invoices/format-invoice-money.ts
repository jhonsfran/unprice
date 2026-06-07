import {
  formatAmountForProvider,
  formatMoney,
  fromCurrencyMinor,
  fromLedgerMinor,
  toDecimal,
} from "@unprice/money"

export function toInvoiceCurrencyMinor(amount: number, currency: string): number {
  const { amount: currencyMinorAmount } = formatAmountForProvider(fromLedgerMinor(amount, currency))

  return currencyMinorAmount
}

export function formatInvoiceCurrencyMinor(amount: number, currency: string): string {
  return formatMoney(toDecimal(fromCurrencyMinor(amount, currency)), currency)
}

export function formatInvoiceMoney(amount: number, currency: string): string {
  return formatInvoiceCurrencyMinor(toInvoiceCurrencyMinor(amount, currency), currency)
}
