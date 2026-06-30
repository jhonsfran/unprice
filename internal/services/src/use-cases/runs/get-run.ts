import type { RunLedgerSummary } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

export type GetRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget?: Pick<RunBudgetClient, "getRunStatus">
}

export type GetRunInput = {
  projectId: string
  runId: string
  keyCustomerId: string | null
}

export async function getRun(
  deps: GetRunDeps,
  input: GetRunInput
): Promise<Result<RunLedgerSummary, RunUseCaseError>> {
  const runResult = await deps.services.budgetRuns.getRun({
    projectId: input.projectId,
    runId: input.runId,
  })

  if (runResult.err) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  const run = runResult.val

  if (input.keyCustomerId !== null && input.keyCustomerId !== run.customerId) {
    return Err(new RunUseCaseError("RUN_NOT_FOUND"))
  }

  const liveSummary =
    run.status === "running" && deps.runBudget
      ? await deps.runBudget.getRunStatus({
          projectId: run.projectId,
          customerId: run.customerId,
          runId: run.id,
        })
      : null

  if (liveSummary?.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  return Ok({
    runId: run.id,
    status: liveSummary?.val.status ?? run.status,
    customerId: run.customerId,
    budgetAmount: liveSummary?.val.budgetAmount ?? run.budgetAmount,
    consumedAmount: liveSummary?.val.consumedAmount ?? run.consumedAmount,
    remainingAmount: liveSummary?.val.remainingAmount ?? run.remainingAmount,
    currency: run.currency,
    workloadType: run.workloadType ?? null,
    workloadId: run.workloadId ?? null,
    traceId: run.traceId ?? null,
    parentRunId: run.parentRunId ?? null,
  })
}
