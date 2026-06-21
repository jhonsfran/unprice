import type { RunSummary } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import { RunUseCaseError } from "./start-run"

export type GetRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget?: unknown
}

export type GetRunInput = {
  projectId: string
  runId: string
  keyCustomerId: string | null
}

export async function getRun(
  deps: GetRunDeps,
  input: GetRunInput
): Promise<Result<RunSummary, RunUseCaseError>> {
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

  return Ok({
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
  })
}
