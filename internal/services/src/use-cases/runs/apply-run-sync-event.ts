import type { MeterConfig } from "@unprice/db/validators"
import type { RunSyncDecision as RunSyncDecisionOutput } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { IngestionEntitlement, IngestionGrant } from "../../ingestion/entitlement-context"
import type { IngestionRejectionReason } from "../../ingestion/interface"
import type { RunBudgetClient } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

/**
 * Resolves the active entitlement for a given feature slug and customer.
 * Returns the entitlement config + grants needed by the EntitlementWindowDO,
 * or a rejection reason if the customer has no valid entitlement.
 */
export type RunEntitlementResolver = {
  resolveForFeature(params: {
    projectId: string
    customerId: string
    featureSlug: string
    eventSlug: string
    eventTimestamp: number
    eventProperties: Record<string, unknown>
  }): Promise<RunEntitlementResolution>
}

export type RunEntitlementResolution =
  | {
      ok: true
      entitlement: IngestionEntitlement & { meterConfig: MeterConfig }
      grants: IngestionGrant[]
    }
  | { ok: false; reason: IngestionRejectionReason }

export type ApplyRunSyncEventDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
  entitlementResolver: RunEntitlementResolver
}

export type ApplyRunSyncEventInput = {
  projectId: string
  runId: string
  keyCustomerId: string | null
  featureSlug: string
  idempotencyKey: string
  event: {
    id: string
    slug: string
    timestamp: number
    properties: Record<string, unknown>
  }
  source: {
    workspaceId: string
    environment: string
    apiKeyId: string | null
    sourceType: "api_key" | "system" | "unknown"
    sourceId: string
    sourceName: string | null
  }
  now: number
}

export async function applyRunSyncEvent(
  deps: ApplyRunSyncEventDeps,
  input: ApplyRunSyncEventInput
): Promise<Result<RunSyncDecisionOutput, RunUseCaseError>> {
  // Load run from Postgres
  const runResult = await deps.services.budgetRuns.getRun({
    projectId: input.projectId,
    runId: input.runId,
  })

  if (runResult.err) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  const run = runResult.val

  // Enforce customer scope
  if (!canAccessRun({ keyCustomerId: input.keyCustomerId, runCustomerId: run.customerId })) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  // Resolve entitlement for the feature slug before delegating to the DO
  const resolution = await deps.entitlementResolver.resolveForFeature({
    projectId: run.projectId,
    customerId: run.customerId,
    featureSlug: input.featureSlug,
    eventSlug: input.event.slug,
    eventTimestamp: input.event.timestamp,
    eventProperties: input.event.properties,
  })

  if (!resolution.ok) {
    return Ok({
      accepted: false,
      reason: mapEntitlementRejection(resolution.reason),
      run: {
        runId: run.id,
        status: run.status,
        customerId: run.customerId,
        budgetAmount: run.budgetAmount,
        consumedAmount: run.consumedAmount,
        remainingAmount: run.remainingAmount,
        currency: run.currency,
        workloadType: run.workloadType ?? null,
        workloadId: run.workloadId ?? null,
        traceId: run.traceId ?? null,
        parentRunId: run.parentRunId ?? null,
      },
    })
  }

  // Delegate to DO with real entitlement data
  const doResult = await deps.runBudget.applySyncEvent({
    projectId: run.projectId,
    customerId: run.customerId,
    runId: run.id,
    featureSlug: input.featureSlug,
    idempotencyKey: input.idempotencyKey,
    event: input.event,
    source: input.source,
    now: input.now,
    customerEntitlementId: resolution.entitlement.customerEntitlementId,
    entitlement: resolution.entitlement,
    grants: resolution.grants,
  })

  if (doResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  const decision = doResult.val

  // Update stored summary
  await deps.services.budgetRuns.updateRunSummary({
    projectId: run.projectId,
    runId: run.id,
    status: decision.budget.status,
    consumedAmount: decision.budget.consumedAmount,
    remainingAmount: decision.budget.remainingAmount,
  })

  return Ok({
    accepted: decision.allowed,
    reason: decision.allowed ? "accepted" : mapRejectionReason(decision.rejectionReason),
    run: {
      runId: run.id,
      status: decision.budget.status,
      customerId: run.customerId,
      budgetAmount: decision.budget.budgetAmount,
      consumedAmount: decision.budget.consumedAmount,
      remainingAmount: decision.budget.remainingAmount,
      currency: run.currency,
      workloadType: run.workloadType ?? null,
      workloadId: run.workloadId ?? null,
      traceId: run.traceId ?? null,
      parentRunId: run.parentRunId ?? null,
    },
  })
}

function canAccessRun(input: { keyCustomerId: string | null; runCustomerId: string }): boolean {
  return input.keyCustomerId === null || input.keyCustomerId === input.runCustomerId
}

function mapEntitlementRejection(
  reason: IngestionRejectionReason
): "insufficient_budget" | "expired" | "not_running" | "entitlement_denied" {
  switch (reason) {
    case "NO_MATCHING_ENTITLEMENT":
    case "UNROUTABLE_EVENT":
    case "INVALID_ENTITLEMENT_CONFIGURATION":
    case "INVALID_AGGREGATION_PROPERTIES":
    case "CUSTOMER_NOT_FOUND":
    case "LIMIT_EXCEEDED":
      return "entitlement_denied"
    case "EVENT_TOO_OLD":
    case "LATE_EVENT_CLOSED_PERIOD":
      return "expired"
    default:
      return "entitlement_denied"
  }
}

function mapRejectionReason(
  reason?: string
): "insufficient_budget" | "expired" | "not_running" | "entitlement_denied" {
  switch (reason) {
    case "RUN_BUDGET_EXCEEDED":
      return "insufficient_budget"
    case "WALLET_EMPTY":
      return "insufficient_budget"
    case "LIMIT_EXCEEDED":
      return "entitlement_denied"
    case "LATE_EVENT_CLOSED_PERIOD":
      return "expired"
    default:
      return "not_running"
  }
}
