import type { RunLedgerSettlementDecision } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { IngestionReportingOutcomeDispatcher } from "../../ingestion"
import type { RunBudgetClient, RunBudgetSummary } from "./run-budget-client"
import {
  type RunEntitlementResolver,
  type RunEventInput,
  type RunRecord,
  loadAccessibleRun,
  mapEntitlementRejection,
  mapRunRejection,
  reportRunDecision,
  reportRunRejection,
  resolveRunEntitlement,
  toPublicRun,
  updateRunFromDecision,
} from "./run-event"
import { RunUseCaseError } from "./start-run"

export type SettleRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
  entitlementResolver: RunEntitlementResolver
  reportingDispatcher: IngestionReportingOutcomeDispatcher
}

export type SettleRunInput = RunEventInput

export async function settleRun(
  deps: SettleRunDeps,
  input: SettleRunInput
): Promise<Result<RunLedgerSettlementDecision, RunUseCaseError>> {
  const loaded = await loadAccessibleRun(deps.services.budgetRuns, input)
  if (loaded.err) return loaded
  const run = loaded.val

  const resolution = await resolveRunEntitlement(deps.entitlementResolver, run, input)
  if (!resolution.ok) {
    const closed = await closeRejectedRun(deps, run, input.now)
    if (closed.err) return closed
    await reportRunRejection({
      event: input,
      reason: resolution.reason,
      reportingDispatcher: deps.reportingDispatcher,
      run,
    })
    return Ok({
      accepted: false,
      reason: mapEntitlementRejection(resolution.reason),
      run: toPublicRun(run, closed.val, "failed"),
    })
  }

  const settled = await deps.runBudget.settleRun({
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
  if (settled.err) return Err(new RunUseCaseError("BUDGET_ERROR"))

  const decision = settled.val
  const status =
    !decision.allowed && decision.budget.status === "canceled"
      ? ("failed" as const)
      : decision.budget.status
  const updated = await updateRunFromDecision({
    budgetRuns: deps.services.budgetRuns,
    decision,
    run,
    status,
  })
  if (updated.err) return updated

  await reportRunDecision({
    decision,
    event: input,
    reportingDispatcher: deps.reportingDispatcher,
    run,
  })

  return Ok({
    accepted: decision.allowed,
    reason: decision.allowed ? "accepted" : mapRunRejection(decision.rejectionReason),
    fundingStatus: decision.fundingStatus,
    fundedAmount: decision.fundedAmount,
    unfundedAmount: decision.unfundedAmount,
    run: toPublicRun(run, decision.budget, status),
  })
}

async function closeRejectedRun(
  deps: SettleRunDeps,
  run: RunRecord,
  endedAt: number
): Promise<Result<RunBudgetSummary, RunUseCaseError>> {
  const closed = await deps.runBudget.endRun({
    projectId: run.projectId,
    customerId: run.customerId,
    runId: run.id,
    status: "canceled",
    endedAt,
  })
  if (closed.err || closed.val.status === "running" || closed.val.endedAt == null) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  const update = await deps.services.budgetRuns.updateRunSummary({
    projectId: run.projectId,
    runId: run.id,
    status: "failed",
    statusReason: "ENTITLEMENT_DENIED",
    consumedAmount: closed.val.consumedAmount,
    remainingAmount: closed.val.remainingAmount,
    endedAt: new Date(closed.val.endedAt),
  })
  return update.err ? Err(new RunUseCaseError("BUDGET_ERROR")) : Ok(closed.val)
}
