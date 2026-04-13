import * as currencies from "@dinero.js/currencies"
import {
  type Dinero,
  add,
  dinero,
  isZero,
  multiply,
  toDecimal,
  toSnapshot,
  transformScale,
  up,
} from "dinero.js"

/**
 * Fixed internal scale for all ledger amounts.
 * 1 USD = 1_000_000 minor units at scale 6.
 * This handles sub-cent AI pricing (e.g., $0.003/token = 3_000 minor units).
 */
export const LEDGER_INTERNAL_SCALE = 6

/**
 * Convert a Dinero amount to ledger storage units (scale 6).
 * Use this at the rating→ledger boundary. After this point the ledger
 * works with plain bigint arithmetic — no Dinero inside LedgerService.
 */
export function formatAmountForLedger(price: Dinero<number>): {
  amount: number
  currency: Currency
} {
  const scaled = transformScale(price, LEDGER_INTERNAL_SCALE, up)
  const { amount, currency } = toSnapshot(scaled)
  return {
    amount,
    currency: currency.code.toLowerCase() as Currency,
  }
}

/**
 * Reconstruct a Dinero object from a ledger minor-unit amount (for display/invoice formatting).
 */
export function ledgerAmountToDinero(amount: number, currency: Currency): Dinero<number> {
  return dinero({
    amount,
    currency: currencies[currency.toUpperCase() as keyof typeof currencies],
    scale: LEDGER_INTERNAL_SCALE,
  })
}

/**
 * Convert ledger scale-6 minor units to provider scale-2 cents.
 * Used when projecting ledger entries into invoice_items (Stripe expects scale-2).
 *
 * Uses round-half-away-from-zero to avoid systematic under/over-billing
 * when sub-cent amounts accumulate (e.g. AI token pricing at $0.003).
 */
export function ledgerAmountToCents(amountMinor: bigint): number {
  const SCALE_FACTOR = BigInt(10_000)
  const HALF = BigInt(5_000)
  const ZERO = BigInt(0)
  const ONE = BigInt(1)
  const quotient = amountMinor / SCALE_FACTOR
  const remainder = amountMinor % SCALE_FACTOR
  const absRemainder = remainder < ZERO ? -remainder : remainder
  if (absRemainder >= HALF) {
    return Number(amountMinor > ZERO ? quotient + ONE : quotient - ONE)
  }
  return Number(quotient)
}

export * from "./utils/_table"
export * from "./utils/aesGcm"
export * from "./utils/hash"
export * from "./utils/constants"
export * from "./utils/id"
export * from "./utils/pagination"
export * from "./utils/nformatter"

export { dinero, type Dinero, currencies, add, toDecimal, isZero }

import { generateSlug } from "random-word-slugs"
import type { Currency } from "./validators"

export const createSlug = () => {
  return generateSlug(2, {
    categories: {
      adjective: ["personality"],
    },
  })
}

export const currencySymbol = (curr: string) =>
  ({
    USD: "$",
    EUR: "€",
    GBP: "£",
  })[curr] ?? curr

export const isSlug = (str?: string) => {
  // slug are always two words separated by a dash
  return str?.split("-").length === 2
}

export const slugify = (str: string, forDisplayingInput?: boolean) => {
  if (!str) {
    return ""
  }

  const s = str
    .toLowerCase() // Convert to lowercase
    .trim() // Remove whitespace from both sides
    .normalize("NFD") // Normalize to decomposed form for handling accents
    // .replace(/\p{Diacritic}/gu, "") // Remove any diacritics (accents) from characters
    // .replace(/[^.\p{L}\p{N}\p{Zs}\p{Emoji}]+/gu, "-") // Replace any non-alphanumeric characters (including Unicode and except "." period) with a dash
    .replace(/[\s_#]+/g, "_") // Replace whitespace, # and underscores with a single dash
    .replace(/^-+/, "") // Remove dashes from start
    .replace(/\.{2,}/g, ".") // Replace consecutive periods with a single period
    .replace(/^\.+/, "") // Remove periods from the start
    .replace(
      /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g,
      ""
    ) // Removes emojis
    .replace(/\s+/g, " ")
    .replace(/-+/g, "_") // Replace consecutive dashes with a single dash

  return forDisplayingInput ? s : s.replace(/-+$/, "").replace(/\.*$/, "") // Remove dashes and period from end
}

// return the price to stripe money format cents
export function formatAmountDinero(price: Dinero<number>) {
  const { currency } = toSnapshot(price)

  // we need to return the amount in cents rounded up to the nearest cent
  const currencyScaleMoney = transformScale(price, currency.exponent, up)

  const { amount } = toSnapshot(currencyScaleMoney)

  return { amount, currency: currency.code.toLowerCase() as Currency }
}

export function calculatePercentage(price: Dinero<number>, percentage: number) {
  if (percentage < 0 || percentage > 1) {
    throw new Error(`Percentage must be between 0 and 1, got ${percentage}`)
  }

  const str = percentage.toString()
  const scale = str.split(".")[1]?.length ?? 0
  const rest = percentage * 10 ** scale

  const result = multiply(price, { amount: Math.round(rest), scale: scale })

  return result
}

export function formatMoney(amount: string, currencyCode = "USD") {
  const userLocale = currencyCode === "USD" ? "en-US" : "es-ES"
  return new Intl.NumberFormat(userLocale, {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(Number.parseFloat(amount))
}
