import type { Database } from "@unprice/db"
import { expect, it, vi } from "vitest"
import { registerBillingUsage, sealBillingUsage } from "../../billing/usage-snapshot"
import type { EntitlementWindowClient } from "../../ingestion/entitlement-window-applier"
import { processBillingUsageSnapshots } from "./usage-snapshots"
it("does not seal another phase while closing a ready fixed statement", async () => {
  const now = Date.UTC(2026, 1, 1)
  const scope = { projectId: "proj_1", customerId: "cust_1", subscriptionId: "sub_1" }
  const periods = [
    {
      ...scope,
      id: "bp_old_usage",
      subscriptionPhaseId: "phase_old",
      subscriptionItemId: "item_old",
      statementKey: "stmt_shared",
      cycleStartAt: Date.UTC(2026, 0, 1),
      cycleEndAt: now,
      status: "pending",
      subscriptionItem: {
        featurePlanVersion: { featureType: "usage", feature: { slug: "events" } },
      },
      subscriptionPhase: { planVersion: { currency: "USD" } },
    },
    {
      ...scope,
      id: "bp_ready_fixed",
      subscriptionPhaseId: "phase_ready",
      subscriptionItemId: "item_fixed",
      statementKey: "stmt_shared",
      cycleStartAt: now,
      cycleEndAt: Date.UTC(2026, 2, 1),
      status: "pending",
      subscriptionItem: {
        featurePlanVersion: { featureType: "flat", feature: { slug: "access" } },
      },
      subscriptionPhase: { planVersion: { currency: "USD" } },
    },
  ]
  const owners = [
    {
      ...scope,
      id: "ent_old",
      subscriptionPhaseId: "phase_old",
      subscriptionItemId: "item_old",
      effectiveAt: Date.UTC(2026, 0, 1),
      expiresAt: now,
    },
  ]
  const select = (rows: Record<string, unknown>[]) =>
    vi.fn(
      async (options: {
        where: (
          table: Record<string, string>,
          operators: unknown
        ) => (row: Record<string, unknown>) => boolean
      }) => {
        const table = new Proxy({}, { get: (_target, key) => key })
        const operators = {
          eq: (key: string, value: unknown) => (row: Record<string, unknown>) => row[key] === value,
          and:
            (...predicates: ((row: Record<string, unknown>) => boolean)[]) =>
            (row: Record<string, unknown>) =>
              predicates.every((predicate) => predicate(row)),
        }
        return rows.filter(options.where(table, operators))
      }
    )
  const sealedIds: string[] = []
  const result = await processBillingUsageSnapshots(
    {
      db: {
        query: {
          billingPeriods: { findMany: select(periods) },
          customerEntitlements: { findMany: select(owners) },
        },
      } as unknown as Database,
      entitlementWindowClient: {
        getEntitlementWindowStub: () => ({
          sealBillingPeriods: async (identities: unknown[]) =>
            identities.map((identity: unknown) => {
              const snapshot = sealBillingUsage(
                registerBillingUsage({
                  ...(identity as object),
                  origin: "period_generation_v1",
                  registeredAt: now - 1000,
                } as never),
                now
              )
              sealedIds.push(snapshot.billingPeriodId)
              return snapshot
            }),
        }),
      } as unknown as EntitlementWindowClient,
    },
    { ...scope, operation: "seal", statementKey: "stmt_shared", subscriptionPhaseId: "phase_ready" }
  )
  if (result.err) throw result.err
  expect(sealedIds).toEqual([])
})
