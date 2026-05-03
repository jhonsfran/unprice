/**
 * Canonical account-key builders. Every account name pgledger stores is built
 * here so the format stays uniform — callers never concatenate strings manually.
 *
 * Five customer sub-accounts (purchased / granted / reserved / consumed /
 * receivable) and five typed platform funding sources (topup / promo /
 * plan_credit / manual / credit_line). `receivable` and `credit_line` are
 * wired in Phase 7 for Phase 8 forward-compatibility (invoicing + postpaid)
 * but not drained by the Phase 7 hot path.
 */

export type PlatformFundingKind = "topup" | "promo" | "plan_credit" | "manual" | "credit_line"

export const PLATFORM_FUNDING_KINDS: readonly PlatformFundingKind[] = [
  "topup",
  "promo",
  "plan_credit",
  "manual",
  "credit_line",
] as const

export function platformAccountKey(kind: PlatformFundingKind, projectId: string): string {
  return `platform.${projectId}.funding.${kind}`
}

export type CustomerAccountKeys = {
  purchased: string
  granted: string
  reserved: string
  consumed: string
  receivable: string
}

export function customerAccountKeys(customerId: string): CustomerAccountKeys {
  return {
    purchased: `customer.${customerId}.available.purchased`,
    granted: `customer.${customerId}.available.granted`,
    reserved: `customer.${customerId}.reserved`,
    consumed: `customer.${customerId}.consumed`,
    receivable: `customer.${customerId}.receivable`,
  }
}

/**
 * Available sub-accounts in drain priority order: granted drains first (funny
 * money — use it or lose it), purchased drains second (real money — preserve).
 */
export function customerAvailableKeys(customerId: string): readonly [string, string] {
  return [
    `customer.${customerId}.available.granted`,
    `customer.${customerId}.available.purchased`,
  ] as const
}
