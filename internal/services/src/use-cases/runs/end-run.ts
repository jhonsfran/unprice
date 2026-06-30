import type { RunLedgerSummary } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

export type EndRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
}

export type EndRunInput = {
  projectId: string
  runId: string
  keyCustomerId: string | null
  status: "completed" | "canceled" | "failed"
}

export async function endRun(
  deps: EndRunDeps,
  input: EndRunInput
): Promise<Result<RunLedgerSummary, RunUseCaseError>> {
  const runResult = await deps.services.budgetRuns.getRun({
    projectId: input.projectId,
    runId: input.runId,
  })

  if (runResult.err) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  const run = runResult.val

  // Enforce customer scope
  if (input.keyCustomerId !== null && input.keyCustomerId !== run.customerId) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  const doStatus = input.status === "failed" ? "canceled" : input.status

  const doResult = await deps.runBudget.endRun({
    projectId: run.projectId,
    customerId: run.customerId,
    runId: run.id,
    status: doStatus as "completed" | "expired" | "canceled",
    endedAt: Date.now(),
  })

  if (doResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  // Persist final summary
  const summaryUpdateResult = await deps.services.budgetRuns.updateRunSummary({
    projectId: run.projectId,
    runId: run.id,
    status: input.status === "failed" ? "failed" : doResult.val.status,
    consumedAmount: doResult.val.consumedAmount,
    remainingAmount: doResult.val.remainingAmount,
    endedAt: new Date(),
  })
  if (summaryUpdateResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  return Ok({
    runId: run.id,
    status: input.status === "failed" ? "failed" : doResult.val.status,
    customerId: run.customerId,
    budgetAmount: doResult.val.budgetAmount,
    consumedAmount: doResult.val.consumedAmount,
    remainingAmount: doResult.val.remainingAmount,
    currency: run.currency,
    workloadType: run.workloadType ?? null,
    workloadId: run.workloadId ?? null,
    traceId: run.traceId ?? null,
    parentRunId: run.parentRunId ?? null,
  })
}
