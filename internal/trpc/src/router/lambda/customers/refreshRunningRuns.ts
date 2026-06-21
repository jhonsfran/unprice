import type { ApiResult } from "@unprice/api"
import type { BudgetRun, RunSummary } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"

type RunsGet = (input: { runId: string; project_id?: string }) => Promise<ApiResult<RunSummary>>

export async function refreshRunningRuns(input: {
  customerId: string
  projectId: string
  runs: BudgetRun[]
  runsGet: RunsGet
  logger: Pick<Logger, "error">
}): Promise<BudgetRun[]> {
  return Promise.all(
    input.runs.map(async (run) => {
      if (run.status !== "running") {
        return run
      }

      const { result: live, error } = await input.runsGet({
        runId: run.id,
        project_id: input.projectId,
      })

      if (error || !live) {
        input.logger.error(new Error(error?.message ?? "Failed to refresh running run"), {
          project_id: input.projectId,
          customer_id: input.customerId,
          run_id: run.id,
        })
        return run
      }

      if (live.customerId !== input.customerId) {
        input.logger.error(new Error("Refreshed run customer mismatch"), {
          project_id: input.projectId,
          customer_id: input.customerId,
          run_id: run.id,
        })
        return run
      }

      return {
        ...run,
        status: live.status,
        budgetAmount: toLedgerMinor(fromCurrencyMinor(live.budgetAmount, live.currency)),
        consumedAmount: toLedgerMinor(fromCurrencyMinor(live.consumedAmount, live.currency)),
        remainingAmount: toLedgerMinor(fromCurrencyMinor(live.remainingAmount, live.currency)),
      }
    })
  )
}
