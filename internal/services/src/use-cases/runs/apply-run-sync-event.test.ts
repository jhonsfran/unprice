import type { AnalyticsEntitlementMeterFact } from "@unprice/analytics"
import type { MeterConfig } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { LEDGER_SCALE } from "@unprice/money"
import { describe, expect, it, vi } from "vitest"
import { type BudgetRunService, BudgetRunServiceError } from "../../budget-runs"
import type {
  IngestionEntitlement,
  IngestionGrant,
  IngestionReportingOutcomeDispatcher,
} from "../../ingestion"
import { type RunEntitlementResolver, applyRunSyncEvent } from "./apply-run-sync-event"
import type { RunBudgetClient } from "./run-budget-client"

const TEST_NOW = Date.UTC(2026, 5, 19, 12, 0, 0)

describe("applyRunSyncEvent", () => {
  it("reports processed RunBudgetDO decisions with run-attributed meter facts", async () => {
    const run = createRun({
      workloadType: "agent",
      workloadId: "research-assistant",
      traceId: "trace_001",
      parentRunId: "brun_parent_001",
    })
    const meterFacts = [
      createMeterFact({
        run_id: run.id,
        trace_id: run.traceId,
        parent_run_id: run.parentRunId,
        workload_type: run.workloadType,
        workload_id: run.workloadId,
      }),
    ]
    const { deps, enqueueOutcomes, runBudget } = createDeps({
      run,
      runBudgetDecision: {
        allowed: true,
        state: "processed",
        budget: {
          runId: run.id,
          status: "running",
          budgetAmount: 1_000_000_000,
          consumedAmount: 100_000_000,
          remainingAmount: 900_000_000,
        },
        meterFacts,
      },
    })

    const input = createInput()
    const result = await applyRunSyncEvent(deps, input)

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      accepted: true,
      reason: "accepted",
      run: {
        runId: run.id,
        workloadType: "agent",
        workloadId: "research-assistant",
        traceId: "trace_001",
        parentRunId: "brun_parent_001",
      },
    })
    expect(runBudget.applySyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: run.projectId,
        customerId: run.customerId,
        runId: run.id,
        featureSlug: input.featureSlug,
        idempotencyKey: input.idempotencyKey,
        event: input.event,
        source: input.source,
        now: input.now,
      })
    )
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: run.customerId,
      projectId: run.projectId,
      outcomes: [
        {
          message: expect.objectContaining({
            version: 1,
            workspaceId: input.source.workspaceId,
            projectId: run.projectId,
            customerId: run.customerId,
            requestId: input.requestId,
            receivedAt: input.receivedAt,
            idempotencyKey: input.idempotencyKey,
            id: input.event.id,
            slug: input.event.slug,
            timestamp: input.event.timestamp,
            properties: input.event.properties,
            source: input.source,
            runContext: {
              runId: run.id,
              traceId: "trace_001",
              parentRunId: "brun_parent_001",
              workloadType: "agent",
              workloadId: "research-assistant",
            },
          }),
          outcome: { state: "processed" },
          meterFacts,
        },
      ],
    })
    expect(enqueueOutcomes.mock.calls[0]?.[0].outcomes[0]?.meterFacts).toEqual([
      expect.objectContaining({
        run_id: run.id,
        workload_id: "research-assistant",
      }),
    ])
  })

  it("reports entitlement-resolution rejections without calling RunBudgetDO", async () => {
    const run = createRun({
      workloadType: "workflow",
      workloadId: "daily-research",
      traceId: "trace_workflow_001",
      parentRunId: null,
    })
    const { deps, enqueueOutcomes, runBudget } = createDeps({
      run,
      entitlementResolution: {
        ok: false,
        reason: "NO_MATCHING_ENTITLEMENT",
      },
    })

    const input = createInput()
    const result = await applyRunSyncEvent(deps, input)

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      accepted: false,
      reason: "entitlement_denied",
    })
    expect(runBudget.applySyncEvent).not.toHaveBeenCalled()
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: run.customerId,
      projectId: run.projectId,
      outcomes: [
        {
          message: expect.objectContaining({
            runContext: {
              runId: run.id,
              traceId: "trace_workflow_001",
              parentRunId: null,
              workloadType: "workflow",
              workloadId: "daily-research",
            },
          }),
          outcome: {
            state: "rejected",
            rejectionReason: "NO_MATCHING_ENTITLEMENT",
          },
          meterFacts: [],
        },
      ],
    })
  })

  it("reports rejected RunBudgetDO decisions with run context", async () => {
    const run = createRun({
      workloadType: "agent",
      workloadId: "research-assistant",
      traceId: "trace_rejected_001",
      parentRunId: "brun_parent_001",
    })
    const { deps, enqueueOutcomes, runBudget } = createDeps({
      run,
      runBudgetDecision: {
        allowed: false,
        state: "rejected",
        rejectionReason: "RUN_BUDGET_EXCEEDED",
        budget: {
          runId: run.id,
          status: "budget_exceeded",
          budgetAmount: 1_000_000_000,
          consumedAmount: 1_000_000_000,
          remainingAmount: 0,
        },
        meterFacts: [],
      },
    })

    const input = createInput()
    const result = await applyRunSyncEvent(deps, input)

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      accepted: false,
      reason: "insufficient_budget",
      run: {
        runId: run.id,
        status: "budget_exceeded",
        workloadType: "agent",
        workloadId: "research-assistant",
        traceId: "trace_rejected_001",
        parentRunId: "brun_parent_001",
      },
    })
    expect(runBudget.applySyncEvent).toHaveBeenCalledOnce()
    expect(enqueueOutcomes).toHaveBeenCalledWith({
      customerId: run.customerId,
      projectId: run.projectId,
      outcomes: [
        {
          message: expect.objectContaining({
            runContext: {
              runId: run.id,
              traceId: "trace_rejected_001",
              parentRunId: "brun_parent_001",
              workloadType: "agent",
              workloadId: "research-assistant",
            },
          }),
          outcome: {
            state: "rejected",
            rejectionReason: "RUN_BUDGET_EXCEEDED",
          },
          meterFacts: [],
        },
      ],
    })
  })

  it("returns a budget error without reporting when the summary update fails", async () => {
    const { deps, enqueueOutcomes } = createDeps({
      updateRunSummaryResult: Err(new BudgetRunServiceError({ message: "summary update failed" })),
    })

    const result = await applyRunSyncEvent(deps, createInput())

    expect(result.err?.message).toBe("BUDGET_ERROR")
    expect(enqueueOutcomes).not.toHaveBeenCalled()
  })
})

function createDeps(
  overrides: {
    entitlementResolution?: Awaited<ReturnType<RunEntitlementResolver["resolveForFeature"]>>
    run?: ReturnType<typeof createRun>
    runBudgetDecision?: Awaited<ReturnType<RunBudgetClient["applySyncEvent"]>>["val"]
    updateRunSummaryResult?: Awaited<ReturnType<BudgetRunService["updateRunSummary"]>>
  } = {}
) {
  const run = overrides.run ?? createRun()
  const getRun = vi.fn().mockResolvedValue(Ok(run))
  const updateRunSummary = vi.fn().mockResolvedValue(overrides.updateRunSummaryResult ?? Ok(run))
  const applySyncEvent = vi.fn<RunBudgetClient["applySyncEvent"]>().mockResolvedValue(
    Ok(
      overrides.runBudgetDecision ?? {
        allowed: true,
        state: "processed",
        budget: {
          runId: run.id,
          status: "running",
          budgetAmount: 1_000_000_000,
          consumedAmount: 100_000_000,
          remainingAmount: 900_000_000,
        },
        meterFacts: [],
      }
    )
  )
  const resolveForFeature = vi.fn<RunEntitlementResolver["resolveForFeature"]>().mockResolvedValue(
    overrides.entitlementResolution ?? {
      ok: true,
      entitlement: createEntitlement(),
      grants: createGrants(),
    }
  )
  const enqueueOutcomes = vi
    .fn<IngestionReportingOutcomeDispatcher["enqueueOutcomes"]>()
    .mockResolvedValue(undefined)

  return {
    deps: {
      services: {
        budgetRuns: {
          getRun,
          updateRunSummary,
        } as unknown as BudgetRunService,
      },
      runBudget: {
        applySyncEvent,
      } as unknown as RunBudgetClient,
      entitlementResolver: {
        resolveForFeature,
      },
      reportingDispatcher: {
        enqueueOutcomes,
      },
    },
    enqueueOutcomes,
    runBudget: {
      applySyncEvent,
    },
  }
}

function createInput() {
  return {
    projectId: "proj_123",
    runId: "brun_abc123",
    keyCustomerId: "cus_123",
    featureSlug: "tokens",
    idempotencyKey: "idem_sync_1",
    requestId: "req_test_123",
    receivedAt: TEST_NOW,
    event: {
      id: "evt_1",
      slug: "token_usage",
      timestamp: TEST_NOW + 100,
      properties: { tokens: 100 },
    },
    source: {
      workspaceId: "ws_123",
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key" as const,
      sourceId: "key_123",
      sourceName: null,
    },
    now: TEST_NOW + 200,
  }
}

function createRun(
  overrides: Partial<{
    id: string
    projectId: string
    customerId: string
    status: "running" | "completed" | "expired" | "canceled" | "budget_exceeded" | "failed"
    budgetAmount: number
    consumedAmount: number
    remainingAmount: number
    currency: string
    workloadType: "agent" | "workflow" | "job" | "tool" | "custom" | null
    workloadId: string | null
    traceId: string | null
    parentRunId: string | null
  }> = {}
) {
  return {
    id: "brun_abc123",
    projectId: "proj_123",
    customerId: "cus_123",
    status: "running" as const,
    budgetAmount: 1_000_000_000,
    consumedAmount: 0,
    remainingAmount: 1_000_000_000,
    currency: "USD",
    workloadType: null,
    workloadId: null,
    traceId: null,
    parentRunId: null,
    ...overrides,
  }
}

function createEntitlement(): IngestionEntitlement & { meterConfig: MeterConfig } {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: TEST_NOW - 1_000,
    expiresAt: null,
    featureConfig: {},
    featurePlanVersionId: "fpv_123",
    featureSlug: "tokens",
    featureType: "usage",
    grants: createGrants(),
    meterConfig: {
      aggregationMethod: "sum",
      aggregationField: "tokens",
    },
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
      allowanceUnits: 1_000,
      cadenceEffectiveAt: TEST_NOW - 1_000,
      cadenceExpiresAt: null,
      currencyCode: "USD",
      effectiveAt: TEST_NOW - 1_000,
      expiresAt: null,
      grantId: "grant_123",
      priority: 0,
      resetConfig: null,
    },
  ]
}

function createMeterFact(
  overrides: Partial<AnalyticsEntitlementMeterFact> = {}
): AnalyticsEntitlementMeterFact {
  return {
    event_id: "evt_1",
    idempotency_key: "idem_sync_1",
    workspace_id: "ws_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    environment: "test",
    api_key_id: "key_123",
    source_type: "api_key",
    source_id: "key_123",
    source_name: null,
    run_id: null,
    trace_id: null,
    parent_run_id: null,
    workload_type: null,
    workload_id: null,
    customer_entitlement_id: "ce_123",
    feature_slug: "tokens",
    period_key: "2026-06",
    event_slug: "token_usage",
    aggregation_method: "sum",
    timestamp: TEST_NOW + 100,
    created_at: TEST_NOW + 200,
    delta: 100,
    value_after: 100,
    grant_id: "grant_123",
    feature_plan_version_id: "fpv_123",
    amount: 100_000_000,
    amount_after: 100_000_000,
    amount_scale: LEDGER_SCALE,
    currency: "USD",
    priced_at: TEST_NOW + 100,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 1,
    ...overrides,
  }
}
