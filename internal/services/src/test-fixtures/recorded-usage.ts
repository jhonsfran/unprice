import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
import { vi } from "vitest"
import {
  type BillingUsageSnapshot,
  ownsBillingUsagePeriod,
  registerBillingUsage,
} from "../billing/usage-snapshot"
import type { BillingReservationFlushGateway } from "../use-cases/billing/reservation-flush-gateway"

type AcceptedUsage = Readonly<Record<string, Pick<BillingUsageSnapshot, "amount" | "quantity">>>

export function createRecordedUsageFixture(db: Database, acceptedUsage: AcceptedUsage) {
  const analytics = {
    getUsageBillingFeatures: vi.fn(async () => Ok([])),
    ingestEvents: vi.fn(),
  } as unknown as Analytics
  const snapshots = new Map<string, BillingUsageSnapshot>()
  const reservationFlushGateway: BillingReservationFlushGateway = {
    registerPeriods: async ({ registrations }) => {
      for (const registration of registrations) {
        const key = `${registration.customerEntitlementId}:${registration.billingPeriodId}`
        if (!snapshots.has(key)) {
          snapshots.set(key, registerBillingUsage(registration))
        }
      }
      return Ok(undefined)
    },
    completeForInvoicing: async () => Ok(undefined),
    flushForInvoicing: async (input) => {
      const periods = await db.query.billingPeriods.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.projectId, input.projectId),
            eq(table.customerId, input.customerId),
            eq(table.subscriptionId, input.subscriptionId),
            eq(table.subscriptionPhaseId, input.subscriptionPhaseId),
            eq(table.statementKey, input.statementKey)
          ),
        with: {
          subscriptionItem: { with: { featurePlanVersion: { with: { feature: true } } } },
          subscriptionPhase: { with: { planVersion: true } },
        },
      })
      const sealed: BillingUsageSnapshot[] = []
      for (const period of periods) {
        if (period.subscriptionItem.featurePlanVersion.featureType !== "usage") continue
        const entitlementRows = await db.query.customerEntitlements.findMany({
          where: (table, { and, eq }) =>
            and(
              eq(table.projectId, input.projectId),
              eq(table.customerId, input.customerId),
              eq(table.subscriptionItemId, period.subscriptionItemId)
            ),
        })
        const owners = entitlementRows.filter((row) => ownsBillingUsagePeriod(row, period))
        const [owner] = owners
        if (owners.length !== 1 || !owner) {
          throw new Error("Recorded usage fixture needs one period owner")
        }
        const key = `${owner.id}:${period.id}`
        const existing = snapshots.get(key)
        if (existing && existing.state !== "open") {
          sealed.push(existing)
          continue
        }
        const featureSlug = period.subscriptionItem.featurePlanVersion.feature.slug
        const accepted = acceptedUsage[featureSlug] ?? { amount: 0, quantity: 0 }
        const snapshot: BillingUsageSnapshot = {
          projectId: input.projectId,
          customerId: input.customerId,
          customerEntitlementId: owner.id,
          subscriptionId: period.subscriptionId,
          subscriptionPhaseId: period.subscriptionPhaseId,
          subscriptionItemId: period.subscriptionItemId,
          billingPeriodId: period.id,
          statementKey: period.statementKey,
          featureSlug,
          cycleStartAt: period.cycleStartAt,
          cycleEndAt: period.cycleEndAt,
          currency: period.subscriptionPhase.planVersion.currency,
          amountScale: 8,
          origin: "period_generation_v1",
          registeredAt: period.cycleStartAt,
          amount: accepted.amount,
          quantity: accepted.quantity,
          lastEventAt: accepted.quantity > 0 ? period.cycleEndAt - 1 : null,
          state: "sealed",
          sealedAt: period.cycleEndAt,
          completedAt: null,
        }
        snapshots.set(key, snapshot)
        sealed.push(snapshot)
      }
      return Ok({ flushed: 0, skipped: 0, snapshots: sealed })
    },
  }
  return { analytics, reservationFlushGateway }
}
