import type { RunSummary } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetRunService } from "../../budget-runs"
import type { RunBudgetClient } from "./run-budget-client"
import { RunUseCaseError } from "./start-run"

export type GetRunDeps = {
  services: Pick<{ budgetRuns: BudgetRunService }, "budgetRuns">
  runBudget: RunBudgetClient
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

  const doResult = await deps.runBudget.getRunStatus({
    projectId: run.projectId,
    customerId: run.customerId,
    runId: run.id,
  })

  if (doResult.err) {
    return Err(new RunUseCaseError("BUDGET_ERROR"))
  }

  return Ok({
    runId: run.id,
    status: doResult.val.status,
    customerId: run.customerId,
    budgetAmount: doResult.val.budgetAmount,
    consumedAmount: doResult.val.consumedAmount,
    remainingAmount: doResult.val.remainingAmount,
    currency: run.currency,
    agentId: run.agentId,
  })
}
