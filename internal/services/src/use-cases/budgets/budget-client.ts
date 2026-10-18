import type { Result } from "@unprice/error"
import type {
  BudgetCommand,
  BudgetOutcome,
  BudgetRejection,
  UnPriceBudgetError,
} from "../../budgets"

export type BudgetAddress = Readonly<{ projectId: string; key: string }>

/** A command as it crosses into the budget's object; only the object's own alarm sweeps. */
export type BudgetRequest = Exclude<BudgetCommand, { type: "sweep" }>

/** Error classes do not survive Workers RPC, so a rejection crosses as plain data. */
export type BudgetReply =
  | Readonly<{ ok: true; outcome: BudgetOutcome }>
  | Readonly<{ ok: false; rejection: BudgetRejection }>

export interface BudgetClient {
  execute(
    address: BudgetAddress,
    request: BudgetRequest
  ): Promise<Result<BudgetOutcome, UnPriceBudgetError>>
}
