import type { Database } from "@unprice/db"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import {
  type BillingUsageSnapshot,
  billingUsageIdentitySchema,
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
const sealSchema = scopeSchema.extend({
  operation: z.literal("seal"),
  statementKey: z.string(),
  subscriptionPhaseId: z.string(),
})
const completeSchema = scopeSchema.extend({ operation: z.literal("complete") })
export const billingUsageOperationSchema = z.discriminatedUnion("operation", [
  registerSchema,
  sealSchema,
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
          input.operation === "seal"
            ? and(
                eq(table.statementKey, input.statementKey),
                eq(table.subscriptionPhaseId, input.subscriptionPhaseId)
              )
            : eq(table.status, "invoiced")
        ),
      with: {
        subscriptionItem: { with: { featurePlanVersion: { with: { feature: true } } } },
        subscriptionPhase: { with: { planVersion: true } },
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
        if (input.operation === "complete") {
          await stub.completeBillingPeriods([period.id])
          continue
        }
        const identity = billingUsageIdentitySchema.parse({
          projectId: input.projectId,
          customerId: input.customerId,
          customerEntitlementId: entitlement.id,
          subscriptionId: period.subscriptionId,
          subscriptionPhaseId: period.subscriptionPhaseId,
          subscriptionItemId: period.subscriptionItemId,
          billingPeriodId: period.id,
          statementKey: period.statementKey,
          featureSlug: item.featurePlanVersion.feature.slug,
          cycleStartAt: period.cycleStartAt,
          cycleEndAt: period.cycleEndAt,
          currency: period.subscriptionPhase.planVersion.currency,
          amountScale: 8,
        })
        snapshots.push(...(await stub.sealBillingPeriods([identity])))
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
