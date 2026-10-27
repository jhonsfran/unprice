import type { CustomerEntitlement, InsertCustomerEntitlement } from "@unprice/db/validators"
import { z } from "zod"

export const BILLING_USAGE_GENESIS_KEY = "billing_usage_genesis_v1"
export const billingUsageGenesisSchema = z.object({
  version: z.literal(1),
  customerEntitlementId: z.string().min(1),
})

export function readBillingUsageGenesis(
  entitlement: Pick<CustomerEntitlement, "id" | "metadata">
): z.infer<typeof billingUsageGenesisSchema> | null {
  return entitlement.metadata?.[BILLING_USAGE_GENESIS_KEY] === entitlement.id
    ? { version: 1, customerEntitlementId: entitlement.id }
    : null
}

export function metadataForNewEntitlement(entitlement: InsertCustomerEntitlement & { id: string }) {
  const metadata = { ...entitlement.metadata }
  delete metadata[BILLING_USAGE_GENESIS_KEY]
  if (
    entitlement.subscriptionId &&
    entitlement.subscriptionPhaseId &&
    entitlement.subscriptionItemId
  ) {
    metadata[BILLING_USAGE_GENESIS_KEY] = entitlement.id
  }
  return Object.keys(metadata).length === 0 ? null : metadata
}
