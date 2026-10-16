import type { Result } from "@unprice/error"
import type {
  BudgetCommand,
  BudgetOutcome,
  BudgetRejection,
  UnPriceBudgetError,
} from "../../budgets"

export type BudgetAddress = Readonly<{ projectId: string; key: string }>

type WithoutRequestHash<C> = C extends { requestHash: string } ? Omit<C, "requestHash"> : C

/** A command as it crosses into the budget's object, which hashes keyed requests itself. */
export type BudgetRequest = WithoutRequestHash<Exclude<BudgetCommand, { type: "sweep" }>>

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
