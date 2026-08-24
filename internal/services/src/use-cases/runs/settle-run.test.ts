import type { MeterConfig } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { type BudgetRunService, BudgetRunServiceError } from "../../budget-runs"
import type {
  IngestionEntitlement,
  IngestionGrant,
  IngestionReportingOutcomeDispatcher,
} from "../../ingestion"
import type { RunBudgetClient } from "./run-budget-client"
import type { RunEntitlementResolver } from "./run-event"
import { settleRun } from "./settle-run"

const NOW = Date.UTC(2026, 7, 24, 12)

describe("settleRun", () => {
  it("settles the event, keeps the run open, and reports meter facts", async () => {
    const { deps, enqueueOutcomes, runBudget, updateRunSummary } = createDeps()

    const result = await settleRun(deps, createInput())

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      accepted: true,
      reason: "accepted",
      fundingStatus: "fully_funded",
      fundedAmount: 500_000_000,
      unfundedAmount: 0,
      run: { status: "running", consumedAmount: 500_000_000 },
    })
    expect(runBudget.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "brun_123",
        idempotencyKey: "settle_123",
      })
    )
    expect(updateRunSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        consumedAmount: 500_000_000,
        endedAt: null,
      })
    )
    expect(enqueueOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            outcome: { state: "processed" },
            meterFacts: [expect.objectContaining({ event_id: "evt_123" })],
          }),
        ],
      })
    )
  })

  it("does not call the pre-work customer bouncer", async () => {
    const { deps, runBudget } = createDeps()

    await settleRun(deps, createInput())

    expect(runBudget.settleRun).toHaveBeenCalledOnce()
    expect("assertCustomerCanConsume" in deps).toBe(false)
  })

  it("hides a run owned by a different API-key customer", async () => {
    const { deps, runBudget } = createDeps()

    const result = await settleRun(deps, { ...createInput(), keyCustomerId: "cus_other" })

    expect(result.err?.message).toBe("RUN_NOT_FOUND")
    expect(runBudget.settleRun).not.toHaveBeenCalled()
  })

  it("reports a partially funded settlement as accepted usage", async () => {
    const { deps, enqueueOutcomes, updateRunSummary } = createDeps({
      decision: {
        allowed: true,
        state: "processed",
        fundingStatus: "partially_funded",
        fundedAmount: 1_000_000_000,
        unfundedAmount: 100_000_000,
        budget: {
          runId: "brun_123",
          status: "running",
          endedAt: null,
          budgetAmount: 1_000_000_000,
          consumedAmount: 1_100_000_000,
          remainingAmount: 0,
        },
        meterFacts: [createMeterFact()],
      },
    })

    const result = await settleRun(deps, createInput())

    expect(result.val).toMatchObject({
      accepted: true,
      reason: "accepted",
      fundingStatus: "partially_funded",
      fundedAmount: 1_000_000_000,
      unfundedAmount: 100_000_000,
      run: { status: "running", consumedAmount: 1_100_000_000, remainingAmount: 0 },
    })
    expect(updateRunSummary).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", statusReason: null, endedAt: null })
    )
    expect(enqueueOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            outcome: { state: "processed" },
            meterFacts: [expect.objectContaining({ event_id: "evt_123" })],
          }),
        ],
      })
    )
  })

  it("does not report settlement before the Postgres summary update succeeds", async () => {
    const { deps, enqueueOutcomes } = createDeps({
      updateRunSummaryResult: Err(new BudgetRunServiceError({ message: "summary update failed" })),
    })

    const result = await settleRun(deps, createInput())

    expect(result.err?.message).toBe("BUDGET_ERROR")
    expect(enqueueOutcomes).not.toHaveBeenCalled()
  })
})

function createDeps(
  overrides: {
    decision?: Awaited<ReturnType<RunBudgetClient["settleRun"]>>["val"]
    updateRunSummaryResult?: Awaited<ReturnType<BudgetRunService["updateRunSummary"]>>
  } = {}
) {
  const run = {
    id: "brun_123",
    projectId: "proj_123",
    customerId: "cus_123",
    status: "running" as const,
    budgetAmount: 1_000_000_000,
    consumedAmount: 0,
    remainingAmount: 1_000_000_000,
    currency: "USD",
    workloadType: "agent" as const,
    workloadId: "chat",
    traceId: null,
    parentRunId: null,
    endedAt: null,
  }
  const meterFact = createMeterFact()
  const getRun = vi.fn().mockResolvedValue(Ok(run))
  const updateRunSummary = vi.fn().mockResolvedValue(overrides.updateRunSummaryResult ?? Ok(run))
  const settleRunMock = vi.fn<RunBudgetClient["settleRun"]>().mockResolvedValue(
    Ok(
      overrides.decision ?? {
        allowed: true,
        state: "processed",
        fundingStatus: "fully_funded",
        fundedAmount: 500_000_000,
        unfundedAmount: 0,
        budget: {
          runId: run.id,
          status: "running",
          endedAt: null,
          budgetAmount: run.budgetAmount,
          consumedAmount: 500_000_000,
          remainingAmount: 500_000_000,
        },
        meterFacts: [meterFact],
      }
    )
  )
  const resolveForFeature = vi.fn<RunEntitlementResolver["resolveForFeature"]>().mockResolvedValue({
    ok: true,
    entitlement: createEntitlement(),
    grants: createGrants(),
  })
  const enqueueOutcomes = vi
    .fn<IngestionReportingOutcomeDispatcher["enqueueOutcomes"]>()
    .mockResolvedValue(undefined)

  return {
    deps: {
      services: { budgetRuns: { getRun, updateRunSummary } as unknown as BudgetRunService },
      runBudget: { settleRun: settleRunMock } as unknown as RunBudgetClient,
      entitlementResolver: { resolveForFeature },
      reportingDispatcher: { enqueueOutcomes },
    },
    enqueueOutcomes,
    runBudget: { settleRun: settleRunMock },
    updateRunSummary,
  }
}

function createMeterFact() {
  return {
    event_id: "evt_123",
    idempotency_key: "settle_123:ew",
    workspace_id: "ws_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    environment: "test",
    api_key_id: "key_123",
    source_type: "api_key" as const,
    source_id: "key_123",
    source_name: null,
    currency: "USD",
    customer_entitlement_id: "ce_123",
    billing_period_id: "bp_123",
    grant_id: "grant_123",
    feature_plan_version_id: "fpv_123",
    feature_slug: "tokens",
    period_key: "period_123",
    event_slug: "tokens_used",
    aggregation_method: "sum",
    timestamp: NOW,
    created_at: NOW,
    delta: 12_000,
    value_after: 16_873,
    amount: 500_000_000,
    amount_after: 500_000_000,
    amount_scale: 8 as const,
    priced_at: NOW,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 1,
    run_id: "brun_123",
    trace_id: null,
    parent_run_id: null,
    workload_type: "agent" as const,
    workload_id: "chat",
  }
}

function createInput() {
  return {
    projectId: "proj_123",
    runId: "brun_123",
    keyCustomerId: "cus_123",
    featureSlug: "tokens",
    idempotencyKey: "settle_123",
    requestId: "req_123",
    receivedAt: NOW,
    event: {
      id: "evt_123",
      slug: "tokens_used",
      timestamp: NOW,
      properties: { total_tokens: 12_000 },
    },
    source: {
      workspaceId: "ws_123",
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key" as const,
      sourceId: "key_123",
      sourceName: null,
    },
    now: NOW,
  }
}

function createEntitlement(): IngestionEntitlement & { meterConfig: MeterConfig } {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: NOW - 1_000,
    expiresAt: null,
    featureConfig: {},
    featurePlanVersionId: "fpv_123",
    featureSlug: "tokens",
    featureType: "usage",
    grants: createGrants(),
    meterConfig: { aggregationMethod: "sum", aggregationField: "total_tokens" },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionId: "sub_123",
    subscriptionItemId: "si_123",
  } as unknown as IngestionEntitlement & { meterConfig: MeterConfig }
}

function createGrants(): IngestionGrant[] {
  return [
    {
      allowanceUnits: 10_000,
      cadenceEffectiveAt: NOW - 1_000,
      cadenceExpiresAt: null,
      currencyCode: "USD",
      effectiveAt: NOW - 1_000,
      expiresAt: null,
      grantId: "grant_123",
      priority: 0,
      resetConfig: null,
    },
  ]
}
