import type { Database } from "@unprice/db"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import {
  addBillingUsage,
  registerBillingUsage,
  sealBillingUsage,
} from "../../billing/usage-snapshot"
import type { EntitlementWindowController } from "../../ingestion"
import { RunBudgetError } from "../runs"
import {
  type FlushReservationsForInvoicingDeps,
  FlushReservationsForInvoicingError,
  flushReservationsForInvoicing,
} from "./flush-reservations-for-invoicing"

const defaultInput = {
  projectId: "proj_1",
  customerId: "cus_1",
  subscriptionId: "sub_1",
  subscriptionPhaseId: "phase_1",
  statementKey: "stmt_1",
}

describe("flushReservationsForInvoicing", () => {
  it("aggregates a matching entitlement window and budget run", async () => {
    const flushReservationForInvoicing = vi.fn().mockResolvedValue({ ok: true, outcome: "flushed" })
    const flushCapturesForInvoicing = vi.fn().mockResolvedValue(Ok({ flushed: 1, skipped: 0 }))
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000 }],
      budgetRuns: [{ id: "brun_1" }],
      entitlements: [
        entitlement({ id: "ce_1" }),
        entitlement({ id: "ce_other", subscriptionPhaseId: "phase_other" }),
      ],
      flushReservationForInvoicing,
      flushCapturesForInvoicing,
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.val).toEqual({ flushed: 2, skipped: 0, snapshots: [] })
    expect(flushReservationForInvoicing).toHaveBeenCalledWith({
      statementKey: "stmt_1",
      billingPeriodIds: ["bp_1"],
    })
    expect(flushCapturesForInvoicing).toHaveBeenCalledWith({
      projectId: "proj_1",
      customerId: "cus_1",
      runId: "brun_1",
      statementKey: "stmt_1",
      billingPeriodIds: ["bp_1"],
    })
  })

  it("scopes billing periods and eligible budget runs with the invoicing predicates", async () => {
    const onBillingWhere = vi.fn()
    const onBudgetWhere = vi.fn()
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000 }],
      budgetRuns: [{ id: "brun_1" }],
      onBillingWhere,
      onBudgetWhere,
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.err).toBeUndefined()
    expect(onBillingWhere).toHaveBeenCalledWith([
      predicate("eq", "projectId", "proj_1"),
      predicate("eq", "customerId", "cus_1"),
      predicate("eq", "subscriptionId", "sub_1"),
      predicate("eq", "subscriptionPhaseId", "phase_1"),
      predicate("eq", "statementKey", "stmt_1"),
    ])
    expect(onBudgetWhere).toHaveBeenCalledWith([
      predicate("eq", "projectId", "proj_1"),
      predicate("eq", "customerId", "cus_1"),
      predicate("ne", "status", "failed"),
      predicate("gt", "consumedAmount", 0),
      predicate("gte", "updatedAt", new Date(1_700_000_000_000)),
    ])
  })

  it("returns a deferred error when an entitlement window asks for a retry", async () => {
    const deps = makeDeps({
      entitlements: [entitlement()],
      flushReservationForInvoicing: vi.fn().mockResolvedValue({
        ok: false,
        outcome: "deferred",
        errorMessage: "pending wallet flush",
      }),
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.err).toBeInstanceOf(FlushReservationsForInvoicingError)
    expect(result.err).toMatchObject({
      reason: "deferred",
      retry: true,
      message: "pending wallet flush",
    })
  })

  it("counts a statement mismatch as skipped", async () => {
    const deps = makeDeps({
      entitlements: [entitlement()],
      flushReservationForInvoicing: vi.fn().mockResolvedValue({
        ok: false,
        outcome: "statement_mismatch",
        errorMessage: "different statement",
      }),
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.val).toEqual({ flushed: 0, skipped: 1, snapshots: [] })
  })

  it.each(["flushed", "no_reservation", "no_unflushed_usage"] as const)(
    "rejects inconsistent ok=false responses for successful outcome %s",
    async (outcome) => {
      const deps = makeDeps({
        entitlements: [entitlement()],
        flushReservationForInvoicing: vi.fn().mockResolvedValue({ ok: false, outcome }),
      })

      const result = await flushReservationsForInvoicing(deps, defaultInput)

      expect(result.err).toMatchObject({
        reason: "flush_failed",
        message: `Reservation flush returned inconsistent result: ${outcome} with ok=false`,
      })
    }
  )

  it("returns entitlements_unavailable when entitlement resolution fails", async () => {
    const deps = makeDeps({
      entitlementsResult: Err(new FetchError({ message: "database unavailable", retry: true })),
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.err).toMatchObject({
      reason: "entitlements_unavailable",
      retry: true,
      message: "Failed to resolve customer entitlements: database unavailable",
    })
  })

  it.each(["recovery_required", "wallet_error"] as const)(
    "returns flush_failed for %s entitlement outcomes",
    async (outcome) => {
      const deps = makeDeps({
        entitlements: [entitlement()],
        flushReservationForInvoicing: vi.fn().mockResolvedValue({
          ok: false,
          outcome,
          errorMessage: `${outcome} failure`,
        }),
      })

      const result = await flushReservationsForInvoicing(deps, defaultInput)

      expect(result.err).toMatchObject({
        reason: "flush_failed",
        retry: true,
        message: `${outcome} failure`,
      })
    }
  )

  it("returns flush_failed when a run budget flush fails", async () => {
    const cause = new RunBudgetError({ message: "capture unavailable" })
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000 }],
      budgetRuns: [{ id: "brun_1" }],
      flushCapturesForInvoicing: vi.fn().mockResolvedValue(Err(cause)),
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.err).toMatchObject({
      reason: "flush_failed",
      retry: true,
      message: "Run budget reservation flush failed: capture unavailable",
    })
    expect(result.err?.cause).toBe(cause)
  })

  it("aggregates idempotent skips without capturing more usage on replay", async () => {
    let persistedFlushes = 0
    let entitlementFlushed = false
    let runFlushed = false
    const flushReservationForInvoicing = vi.fn(async () => {
      if (entitlementFlushed) {
        return { ok: true, outcome: "no_unflushed_usage" as const }
      }
      entitlementFlushed = true
      persistedFlushes++
      return { ok: true, outcome: "flushed" as const }
    })
    const flushCapturesForInvoicing = vi.fn(async () => {
      if (runFlushed) {
        return Ok({ flushed: 0, skipped: 1 })
      }
      runFlushed = true
      persistedFlushes++
      return Ok({ flushed: 1, skipped: 0 })
    })
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000 }],
      budgetRuns: [{ id: "brun_1" }],
      entitlements: [entitlement()],
      flushReservationForInvoicing,
      flushCapturesForInvoicing,
    })

    const first = await flushReservationsForInvoicing(deps, defaultInput)
    const replay = await flushReservationsForInvoicing(deps, defaultInput)

    expect(first.val).toEqual({ flushed: 2, skipped: 0, snapshots: [] })
    expect(replay.val).toEqual({ flushed: 0, skipped: 2, snapshots: [] })
    expect(persistedFlushes).toBe(2)
    expect(flushReservationForInvoicing).toHaveBeenCalledTimes(2)
    expect(flushCapturesForInvoicing).toHaveBeenCalledTimes(2)
  })

  it("does not query budget runs when the statement has no billing periods", async () => {
    const deps = makeDeps({ billingPeriods: [] })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.val).toEqual({ flushed: 0, skipped: 0, snapshots: [] })
    expect(deps.db.query.budgetRuns.findMany).not.toHaveBeenCalled()
  })

  it("flushes an owner that expired at the billed service window end", async () => {
    const start = 1_700_000_000_000
    const end = start + 86_400_000
    const expiredOwner = entitlement({ effectiveAt: start, expiresAt: end })
    const flush = vi.fn().mockResolvedValue({ ok: true, outcome: "flushed" })
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: start, cycleEndAt: end }],
      flushReservationForInvoicing: flush,
    })
    vi.mocked(deps.services.entitlements.getCustomerEntitlementsForCustomer).mockImplementation(
      async (query) =>
        Ok(query.startAt === start && query.endAt === end ? [expiredOwner] : []) as Awaited<
          ReturnType<typeof deps.services.entitlements.getCustomerEntitlementsForCustomer>
        >
    )

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.val).toEqual({ flushed: 1, skipped: 0, snapshots: [] })
    expect(flush).toHaveBeenCalledWith({ statementKey: "stmt_1", billingPeriodIds: ["bp_1"] })
  })
  it("seals usage before flushing any entitlement or run capture", async () => {
    const order: string[] = []
    const sealBillingPeriods = vi.fn<EntitlementWindowController["sealBillingPeriods"]>(
      async (identities) => {
        order.push("seal")
        return identities.map((identity) =>
          sealBillingUsage(
            addBillingUsage(
              registerBillingUsage({
                ...identity,
                origin: "period_generation_v1",
                registeredAt: identity.cycleStartAt,
              }),
              {
                amount: 1_000_000_000,
                quantity: 10,
                currency: "USD",
                amountScale: 8,
                timestamp: identity.cycleStartAt,
              }
            ),
            identity.cycleEndAt
          )
        )
      }
    )
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000, featureType: "usage" }],
      entitlements: [entitlement()],
      budgetRuns: [{ id: "brun_1" }],
      sealBillingPeriods,
      flushReservationForInvoicing: vi.fn<
        EntitlementWindowController["flushReservationForInvoicing"]
      >(async () => {
        order.push("entitlement")
        return { ok: true, outcome: "flushed" }
      }),
      flushCapturesForInvoicing: vi.fn(async () => {
        order.push("run")
        return Ok({ flushed: 1, skipped: 0 })
      }),
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(order).toEqual(["seal", "entitlement", "run"])
    expect(result.val).toMatchObject({
      flushed: 2,
      skipped: 0,
      snapshots: [
        {
          billingPeriodId: "bp_1",
          customerEntitlementId: "ce_1",
          state: "sealed",
          amount: 1_000_000_000,
          quantity: 10,
        },
      ],
    })
    expect(sealBillingPeriods).toHaveBeenCalledWith([
      {
        ...defaultInput,
        billingPeriodId: "bp_1",
        customerEntitlementId: "ce_1",
        subscriptionItemId: "item_1",
        featureSlug: "events",
        currency: "USD",
        amountScale: 8,
        cycleStartAt: 1_700_000_000_000,
        cycleEndAt: 1_700_086_400_000,
      },
    ])
  })

  it("does not flush captures when a usage owner cannot be sealed", async () => {
    const flushReservationForInvoicing = vi.fn()
    const flushCapturesForInvoicing = vi.fn()
    const deps = makeDeps({
      billingPeriods: [{ id: "bp_1", cycleStartAt: 1_700_000_000_000, featureType: "usage" }],
      entitlements: [entitlement()],
      budgetRuns: [{ id: "brun_1" }],
      sealBillingPeriods: vi.fn().mockRejectedValue(new Error("snapshot unavailable")),
      flushReservationForInvoicing,
      flushCapturesForInvoicing,
    })

    const result = await flushReservationsForInvoicing(deps, defaultInput)

    expect(result.err).toMatchObject({ reason: "deferred", message: "snapshot unavailable" })
    expect(flushReservationForInvoicing).not.toHaveBeenCalled()
    expect(flushCapturesForInvoicing).not.toHaveBeenCalled()
  })

  it("does not seal another phase that shares a ready fixed statement", async () => {
    const sealBillingPeriods = vi.fn()
    const deps = makeDeps({
      billingPeriods: [
        {
          id: "bp_old_usage",
          cycleStartAt: 1_700_000_000_000,
          featureType: "usage",
          subscriptionPhaseId: "phase_old",
        },
        {
          id: "bp_ready_fixed",
          cycleStartAt: 1_700_086_400_000,
          featureType: "flat",
          subscriptionPhaseId: "phase_ready",
        },
      ],
      entitlements: [entitlement({ subscriptionPhaseId: "phase_old" })],
      sealBillingPeriods,
    })

    const result = await flushReservationsForInvoicing(deps, {
      ...defaultInput,
      subscriptionPhaseId: "phase_ready",
    })

    expect(result.val).toEqual({ flushed: 0, skipped: 0, snapshots: [] })
    expect(sealBillingPeriods).not.toHaveBeenCalled()
  })
})

type Entitlement = {
  id: string
  subscriptionId: string
  subscriptionPhaseId: string
  subscriptionItemId: string
  effectiveAt: number
  expiresAt: number | null
}

type CapturedPredicate = {
  operator: "eq" | "gt" | "gte" | "ne"
  field: string
  value: unknown
}

type PredicateOperators = {
  and: (...predicates: CapturedPredicate[]) => CapturedPredicate[]
  eq: (field: string, value: unknown) => CapturedPredicate
  gt: (field: string, value: unknown) => CapturedPredicate
  gte: (field: string, value: unknown) => CapturedPredicate
  ne: (field: string, value: unknown) => CapturedPredicate
}

type CapturedQuery = {
  where: (table: Record<string, string>, operators: PredicateOperators) => CapturedPredicate[]
}

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: "ce_1",
    subscriptionId: "sub_1",
    subscriptionPhaseId: "phase_1",
    subscriptionItemId: "item_1",
    effectiveAt: 0,
    expiresAt: null,
    ...overrides,
  }
}

function makeDeps(
  options: {
    billingPeriods?: Array<{
      id: string
      cycleStartAt: number
      cycleEndAt?: number
      featureType?: "usage" | "flat"
      subscriptionPhaseId?: string
      subscriptionItemId?: string
    }>
    budgetRuns?: Array<{ id: string }>
    entitlements?: Entitlement[]
    entitlementsResult?: Result<Entitlement[], FetchError>
    sealBillingPeriods?: EntitlementWindowController["sealBillingPeriods"]
    flushReservationForInvoicing?: EntitlementWindowController["flushReservationForInvoicing"]
    flushCapturesForInvoicing?: FlushReservationsForInvoicingDeps["runBudgetClient"]["flushCapturesForInvoicing"]
    onBillingWhere?: (predicates: CapturedPredicate[]) => void
    onBudgetWhere?: (predicates: CapturedPredicate[]) => void
  } = {}
): FlushReservationsForInvoicingDeps {
  const billingPeriodsFindMany = vi.fn(async (query: CapturedQuery) => {
    const predicates = query.where(
      {
        projectId: "projectId",
        customerId: "customerId",
        subscriptionId: "subscriptionId",
        subscriptionPhaseId: "subscriptionPhaseId",
        statementKey: "statementKey",
      },
      predicateOperators
    )
    options.onBillingWhere?.(predicates)
    return (options.billingPeriods ?? [{ id: "bp_1", cycleStartAt: 1_700_000_000_000 }])
      .map((period) => ({
        ...defaultInput,
        subscriptionItemId: "item_1",
        cycleEndAt: period.cycleStartAt + 86_400_000,
        subscriptionItem: {
          featurePlanVersion: {
            featureType: period.featureType ?? "flat",
            feature: { slug: "events" },
          },
        },
        subscriptionPhase: { planVersion: { currency: "USD" } },
        ...period,
      }))
      .filter((period) =>
        predicates.every((predicate) => Reflect.get(period, predicate.field) === predicate.value)
      )
  })
  const budgetRunsFindMany = vi.fn(async (query: CapturedQuery) => {
    options.onBudgetWhere?.(
      query.where(
        {
          projectId: "projectId",
          customerId: "customerId",
          status: "status",
          consumedAmount: "consumedAmount",
          updatedAt: "updatedAt",
        },
        predicateOperators
      )
    )
    return options.budgetRuns ?? []
  })
  const db = {
    query: {
      billingPeriods: { findMany: billingPeriodsFindMany },
      budgetRuns: { findMany: budgetRunsFindMany },
    },
  } as unknown as Database
  const flushReservationForInvoicing =
    options.flushReservationForInvoicing ??
    vi.fn().mockResolvedValue({ ok: true, outcome: "no_reservation" })

  return {
    db,
    entitlementWindowClient: {
      getEntitlementWindowStub: vi.fn().mockReturnValue({
        flushReservationForInvoicing,
        sealBillingPeriods: options.sealBillingPeriods ?? vi.fn().mockResolvedValue([]),
      }),
    },
    runBudgetClient: {
      flushCapturesForInvoicing:
        options.flushCapturesForInvoicing ??
        vi.fn().mockResolvedValue(Ok({ flushed: 0, skipped: 0 })),
    },
    services: {
      entitlements: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(options.entitlementsResult ?? Ok(options.entitlements ?? [])),
      } as unknown as FlushReservationsForInvoicingDeps["services"]["entitlements"],
    },
  }
}

const predicateOperators: PredicateOperators = {
  and: (...predicates) => predicates,
  eq: (field, value) => predicate("eq", field, value),
  gt: (field, value) => predicate("gt", field, value),
  gte: (field, value) => predicate("gte", field, value),
  ne: (field, value) => predicate("ne", field, value),
}

function predicate(
  operator: CapturedPredicate["operator"],
  field: string,
  value: unknown
): CapturedPredicate {
  return { operator, field, value }
}
