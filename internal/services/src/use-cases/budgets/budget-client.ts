import type { Result } from "@unprice/error"
import type { BudgetCommand, BudgetOutcome, BudgetReply, UnPriceBudgetError } from "../../budgets"

export type BudgetAddress = Readonly<{ projectId: string; key: string }>

/** A command as it crosses into the budget's object; only the object's own alarm sweeps. */
export type BudgetRequest = Exclude<BudgetCommand, { type: "sweep" }>

export type { BudgetReply }

export interface BudgetClient {
  execute(
    address: BudgetAddress,
    request: BudgetRequest
  ): Promise<Result<BudgetOutcome, UnPriceBudgetError>>
}
