import type { Database } from "@unprice/db"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import {
  type BillingUsageRegistration,
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
    if (input.operation === "register") {
      const registrationsByOwner = new Map<string, BillingUsageRegistration[]>()
      for (const registration of input.registrations) {
        if (
          registration.projectId !== input.projectId ||
          registration.customerId !== input.customerId ||
          registration.subscriptionId !== input.subscriptionId
        ) {
          throw new Error("Billing usage registration is outside its authenticated scope")
        }
        const registrations = registrationsByOwner.get(registration.customerEntitlementId) ?? []
        registrations.push(registration)
        registrationsByOwner.set(registration.customerEntitlementId, registrations)
      }
      const registered = await Promise.all(
        [...registrationsByOwner].map(([customerEntitlementId, registrations]) => {
          const stub = deps.entitlementWindowClient.getEntitlementWindowStub({
            projectId: input.projectId,
            customerId: input.customerId,
            customerEntitlementId,
          })
          return stub.registerBillingPeriods(registrations)
        })
      )
      return Ok({ snapshots: registered.flat() })
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
    const periodsByOwner = new Map<string, string[]>()
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
        const periodIds = periodsByOwner.get(entitlement.id) ?? []
        periodIds.push(period.id)
        periodsByOwner.set(entitlement.id, periodIds)
      }
    }
    await Promise.all(
      [...periodsByOwner].map(([customerEntitlementId, periodIds]) => {
        const stub = deps.entitlementWindowClient.getEntitlementWindowStub({
          customerEntitlementId,
          customerId: input.customerId,
          projectId: input.projectId,
        })
        return stub.completeBillingPeriods(periodIds)
      })
    )
    return Ok({ snapshots: [] })
  } catch (error) {
    return Err(
      new FetchError({
        message: error instanceof Error ? error.message : String(error),
        retry: true,
      })
    )
  }
}
