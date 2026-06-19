import type { RunSyncDecision as RunSyncDecisionOutput } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

export type ApplyRunSyncEventDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
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

  // Delegate to DO
  const doResult = await deps.runBudget.applySyncEvent({
    projectId: run.projectId,
    customerId: run.customerId,
    runId: run.id,
    featureSlug: input.featureSlug,
    idempotencyKey: input.idempotencyKey,
    event: input.event,
    source: input.source,
    now: input.now,
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
      agentId: run.agentId,
    },
  })
}

function canAccessRun(input: { keyCustomerId: string | null; runCustomerId: string }): boolean {
  return input.keyCustomerId === null || input.keyCustomerId === input.runCustomerId
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
