import type { Database } from "@unprice/db"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import {
  type BillingUsageSnapshot,
  billingUsageRegistrationSchema,
  billingUsageSnapshotSchema,
  ownsBillingUsagePeriod,
} from "../../billing/usage-snapshot"
import type { EntitlementWindowClient } from "../../ingestion/entitlement-window-applier"

const scopeSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
  subscriptionId: z.string(),
})
const registerSchema = scopeSchema.extend({
  operation: z.literal("register"),
  registrations: z.array(billingUsageRegistrationSchema),
})
const completeSchema = scopeSchema.extend({ operation: z.literal("complete") })
export const billingUsageOperationSchema = z.discriminatedUnion("operation", [
  registerSchema,
  completeSchema,
])
export const billingUsageOperationOutputSchema = z.object({
  snapshots: z.array(billingUsageSnapshotSchema),
})
export type BillingUsageOperation = z.infer<typeof billingUsageOperationSchema>

export async function processBillingUsageSnapshots(
  deps: { db: Database; entitlementWindowClient: EntitlementWindowClient },
  rawInput: BillingUsageOperation
): Promise<Result<z.infer<typeof billingUsageOperationOutputSchema>, FetchError>> {
  const input = billingUsageOperationSchema.parse(rawInput)
  try {
    const snapshots: BillingUsageSnapshot[] = []
    if (input.operation === "register") {
      for (const registration of input.registrations) {
        if (
          registration.projectId !== input.projectId ||
          registration.customerId !== input.customerId ||
          registration.subscriptionId !== input.subscriptionId
        ) {
          throw new Error("Billing usage registration is outside its authenticated scope")
        }
        const stub = deps.entitlementWindowClient.getEntitlementWindowStub(registration)
        snapshots.push(...(await stub.registerBillingPeriods([registration])))
      }
      return Ok({ snapshots })
    }

    const periods = await deps.db.query.billingPeriods.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.projectId, input.projectId),
          eq(table.customerId, input.customerId),
          eq(table.subscriptionId, input.subscriptionId),
          eq(table.status, "invoiced")
        ),
      with: {
        subscriptionItem: { with: { featurePlanVersion: { columns: { featureType: true } } } },
      },
    })
    const entitlements = await deps.db.query.customerEntitlements.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.projectId, input.projectId),
          eq(table.customerId, input.customerId),
          eq(table.subscriptionId, input.subscriptionId)
        ),
    })
    for (const period of periods) {
      const item = period.subscriptionItem
      if (item.featurePlanVersion.featureType !== "usage") continue
      const owners = entitlements.filter(
        (entitlement) =>
          entitlement.subscriptionItemId === period.subscriptionItemId &&
          entitlement.subscriptionPhaseId === period.subscriptionPhaseId &&
          ownsBillingUsagePeriod(entitlement, period)
      )
      if (owners.length === 0) throw new Error(`No entitlement owns billing period ${period.id}`)
      for (const entitlement of owners) {
        const stub = deps.entitlementWindowClient.getEntitlementWindowStub({
          customerEntitlementId: entitlement.id,
          customerId: input.customerId,
          projectId: input.projectId,
        })
        await stub.completeBillingPeriods([period.id])
      }
    }
    return Ok({ snapshots })
  } catch (error) {
    return Err(
      new FetchError({
        message: error instanceof Error ? error.message : String(error),
        retry: true,
      })
    )
  }
}
