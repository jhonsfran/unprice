"use client"

import { fromLedgerAmount, fromLedgerMinor, toDecimal, toLedgerMinor } from "@unprice/money"
import { useEffect, useState } from "react"
import { InputWithAddons } from "~/components/input-addons"

/**
 * Money input backed by a ledger-scale integer (scale 8; 1 USD =
 * 100,000,000). Renders/edits the amount as a currency decimal and reports
 * the parsed ledger amount, or `null` when the field is cleared.
 */
export function LedgerAmountInput({
  value,
  onChange,
  currency,
  disabled,
  placeholder = "Derived",
}: {
  value: unknown
  onChange: (value: number | null) => void
  currency: string
  disabled?: boolean
  placeholder?: string
}) {
  const [displayValue, setDisplayValue] = useState(() =>
    formatLedgerAmount(normalizeLedgerAmount(value), currency)
  )

  useEffect(() => {
    setDisplayValue(formatLedgerAmount(normalizeLedgerAmount(value), currency))
  }, [currency, value])

  return (
    <InputWithAddons
      inputMode="decimal"
      placeholder={placeholder}
      leading={currency}
      value={displayValue}
      disabled={disabled}
      onChange={(event) => {
        const nextValue = event.target.value
        setDisplayValue(nextValue)

        if (nextValue.trim() === "") {
          onChange(null)
          return
        }

        try {
          const parsed = toLedgerMinor(fromLedgerAmount(nextValue, currency))
          if (Number.isFinite(parsed) && parsed >= 0) {
            onChange(parsed)
          }
        } catch {
          return
        }
      }}
      onBlur={() => {
        setDisplayValue(formatLedgerAmount(normalizeLedgerAmount(value), currency))
      }}
    />
  )
}

function normalizeLedgerAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function formatLedgerAmount(value: number | null, currency: string): string {
  return value === null
    ? ""
    : toDecimal(fromLedgerMinor(value, currency))
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "")
}
