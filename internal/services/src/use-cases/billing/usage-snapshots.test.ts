import type { Database } from "@unprice/db"
import { describe, expect, it, vi } from "vitest"
import { registerBillingUsage } from "../../billing/usage-snapshot"
import type { EntitlementWindowClient } from "../../ingestion/entitlement-window-applier"
import { billingUsageOperationSchema, processBillingUsageSnapshots } from "./usage-snapshots"

const scope = { projectId: "proj_1", customerId: "cus_1", subscriptionId: "sub_1" }
const registration = {
  ...scope,
  customerEntitlementId: "ce_1",
  subscriptionPhaseId: "phase_1",
  subscriptionItemId: "item_1",
  billingPeriodId: "bp_1",
  statementKey: "stmt_1",
  featureSlug: "events",
  cycleStartAt: 1000,
  cycleEndAt: 2000,
  currency: "USD" as const,
  amountScale: 8 as const,
  origin: "period_generation_v1" as const,
  registeredAt: 900,
}

describe("processBillingUsageSnapshots", () => {
  it("registers a new period through its entitlement owner", async () => {
    const snapshot = registerBillingUsage(registration)
    const registerBillingPeriods = vi.fn().mockResolvedValue([snapshot])
    const getEntitlementWindowStub = vi.fn().mockReturnValue({ registerBillingPeriods })

    const result = await processBillingUsageSnapshots(
      {
        db: {} as Database,
        entitlementWindowClient: { getEntitlementWindowStub } as unknown as EntitlementWindowClient,
      },
      { ...scope, operation: "register", registrations: [registration] }
    )

    expect(result.val).toEqual({ snapshots: [snapshot] })
    expect(registerBillingPeriods).toHaveBeenCalledWith([registration])
  })

  it("rejects registration outside the authenticated scope before contacting the owner", async () => {
    const getEntitlementWindowStub = vi.fn()

    const result = await processBillingUsageSnapshots(
      {
        db: {} as Database,
        entitlementWindowClient: { getEntitlementWindowStub },
      },
      {
        ...scope,
        operation: "register",
        registrations: [{ ...registration, customerId: "cus_other" }],
      }
    )

    expect(result.err?.message).toBe(
      "Billing usage registration is outside its authenticated scope"
    )
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
  })

  it("completes only invoiced usage periods and their overlapping owners", async () => {
    const completeBillingPeriods = vi.fn().mockResolvedValue(undefined)
    const getEntitlementWindowStub = vi.fn().mockReturnValue({ completeBillingPeriods })
    const period = {
      ...scope,
      id: "bp_1",
      status: "invoiced",
      subscriptionPhaseId: "phase_1",
      subscriptionItemId: "item_1",
      cycleStartAt: 1000,
      cycleEndAt: 2000,
      subscriptionItem: { featurePlanVersion: { featureType: "usage" } },
    }
    const owner = {
      ...scope,
      id: "ce_1",
      subscriptionPhaseId: "phase_1",
      subscriptionItemId: "item_1",
      effectiveAt: 1000,
      expiresAt: 2000,
    }
    const db = {
      query: {
        billingPeriods: {
          findMany: select([
            period,
            { ...period, id: "bp_pending", status: "pending" },
            {
              ...period,
              id: "bp_fixed",
              subscriptionItem: { featurePlanVersion: { featureType: "flat" } },
            },
          ]),
        },
        customerEntitlements: {
          findMany: select([
            owner,
            { ...owner, id: "ce_next", effectiveAt: 2000, expiresAt: 3000 },
            { ...owner, id: "ce_other_phase", subscriptionPhaseId: "phase_other" },
          ]),
        },
      },
    } as unknown as Database

    const result = await processBillingUsageSnapshots(
      {
        db,
        entitlementWindowClient: { getEntitlementWindowStub } as unknown as EntitlementWindowClient,
      },
      { ...scope, operation: "complete" }
    )

    expect(result.val).toEqual({ snapshots: [] })
    expect(getEntitlementWindowStub).toHaveBeenCalledTimes(1)
    expect(getEntitlementWindowStub).toHaveBeenCalledWith({
      customerEntitlementId: "ce_1",
      customerId: "cus_1",
      projectId: "proj_1",
    })
    expect(completeBillingPeriods).toHaveBeenCalledWith(["bp_1"])
  })

  it("does not expose a separate seal operation", () => {
    expect(
      billingUsageOperationSchema.safeParse({
        ...scope,
        operation: "seal",
        statementKey: "stmt_1",
        subscriptionPhaseId: "phase_1",
      }).success
    ).toBe(false)
  })
})

function select(rows: Record<string, unknown>[]) {
  return vi.fn(
    async (options: {
      where: (
        table: Record<string, string>,
        operators: {
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => boolean
          and: (
            ...predicates: ((row: Record<string, unknown>) => boolean)[]
          ) => (row: Record<string, unknown>) => boolean
        }
      ) => (row: Record<string, unknown>) => boolean
    }) => {
      const table = new Proxy<Record<string, string>>({}, { get: (_target, key) => key })
      const predicate = options.where(table, {
        eq: (field, value) => (row) => row[field] === value,
        and:
          (...predicates) =>
          (row) =>
            predicates.every((predicate) => predicate(row)),
      })
      return rows.filter(predicate)
    }
  )
}
