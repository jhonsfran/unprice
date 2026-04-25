/**
 * Canonical account-key builders. Every account name pgledger stores is built
 * here so the format stays uniform — callers never concatenate strings manually.
 *
 * Phase 7 introduces four customer sub-accounts (purchased / granted / reserved
 * / consumed) and four typed platform funding sources (topup / promo /
 * plan_credit / manual). The full Chart of Accounts lands in Phase 8; widen the
 * union then.
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
