import type { PaymentProviderConfig } from "@unprice/db/validators"

export function isStripeProviderReady(config: PaymentProviderConfig): boolean {
  return Boolean(config.externalAccountId) && config.status === "active"
}
