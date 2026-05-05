/**
 * Canonical account-key builders. Every account name pgledger stores is built
 * here so the format stays uniform — callers never concatenate strings manually.
 *
 * Five customer sub-accounts (purchased / granted / reserved / consumed /
 * receivable) and five typed platform funding sources (topup / promo /
 * plan_credit / manual / credit_line). `receivable` and `credit_line` support
 * invoicing and postpaid flows but are not drained by the wallet hot path.
 */

export type PlatformFundingKind = "topup" | "promo" | "plan_credit" | "manual" | "credit_line"

export const PLATFORM_FUNDING_KINDS: readonly PlatformFundingKind[] = [
  // Customer self-serve top-ups (cash collected).
  "topup",
  // Promotional credits funded by the platform.
  "promo",
  // Credits granted by subscription plan entitlements.
  "plan_credit",
  // Operator/support manual credit or debit adjustments.
  "manual",
  // Postpaid spending line tracked as customer receivable.
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
    // Purchased credits paid by the customer and available to spend.
    purchased: `customer.${customerId}.available.purchased`,
    // Granted credits issued by the platform (promo/trial/adjustments) and available to spend.
    granted: `customer.${customerId}.available.granted`,
    // Funds temporarily held while usage is pending final settlement.
    reserved: `customer.${customerId}.reserved`,
    // Lifetime settled usage already drained from available/reserved balances.
    consumed: `customer.${customerId}.consumed`,
    // Outstanding postpaid balance owed by the customer (invoice-able debt).
    receivable: `customer.${customerId}.receivable`,
  }
}

/**
 * Available sub-accounts in drain priority order: granted drains first (funny
 * money — use it or lose it), purchased drains second (real money — preserve).
 */
export function customerAvailableKeys(customerId: string): readonly [string, string] {
  return [
    // Drain this first so expiring/non-cash credits are used before paid balance.
    `customer.${customerId}.available.granted`,
    // Drain this second to preserve customer-paid credits when possible.
    `customer.${customerId}.available.purchased`,
  ] as const
}
