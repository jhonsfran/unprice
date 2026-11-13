const PAYER_BUDGET_KEY_PREFIX = "unprice:customer:"

/** The budget key billing writes for a customer. */
export function payerBudgetKey(customerId: string): string {
  return `${PAYER_BUDGET_KEY_PREFIX}${customerId}`
}

/** The customer of a payer budget key, or null for any other budget. */
export function customerOfKey(key: string): string | null {
  return key.startsWith(PAYER_BUDGET_KEY_PREFIX) ? key.slice(PAYER_BUDGET_KEY_PREFIX.length) : null
}
