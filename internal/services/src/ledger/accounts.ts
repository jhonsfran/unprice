import type { Currency } from "@unprice/db/validators"

/**
 * Canonical account-key builders. Every account name pgledger stores is
 * built here so the format stays uniform across customer, house, and grant
 * accounts — callers never concatenate strings manually.
 */

export type HouseAccountKind = "revenue" | "credit_issuance" | "expired_credits" | "refunds"

/**
 * Four canonical house accounts seeded per `(project, currency)` tuple.
 * `credit_issuance` and `expired_credits` currently receive no transfers —
 * they exist for the grant/wallet flows that compose on top.
 */
export const HOUSE_ACCOUNT_KINDS: readonly HouseAccountKind[] = [
  "revenue",
  "credit_issuance",
  "expired_credits",
  "refunds",
] as const

export function houseAccountKey(
  kind: HouseAccountKind,
  projectId: string,
  currency: Currency
): string {
  return `house:${kind}:${projectId}:${currency}`
}

export function customerAccountKey(customerId: string, currency: Currency): string {
  return `customer:${customerId}:${currency}`
}

export function grantAccountKey(grantId: string): string {
  return `grant:${grantId}`
}
