import type { Result } from "@unprice/error"
import type {
  BudgetCommand,
  BudgetInspectQuery,
  BudgetInspection,
  BudgetOutcome,
  BudgetReply,
  FundingResult,
  FundingWork,
  UnPriceBudgetError,
} from "../../budgets"
import type { CardRows } from "../../pricing"
import type { UnPriceWalletError } from "../../wallet"

export type BudgetAddress = Readonly<{ projectId: string; key: string }>

/** A command as it crosses into the budget's object; only the object's own alarm sweeps. */
export type BudgetRequest = Exclude<BudgetCommand, { type: "sweep" }>

export type { BudgetReply }

export interface BudgetClient {
  inspect(
    address: BudgetAddress,
    query: BudgetInspectQuery
  ): Promise<Result<BudgetInspection, UnPriceBudgetError>>
  execute(
    address: BudgetAddress,
    request: BudgetRequest,
    cards?: readonly CardRows[]
  ): Promise<Result<BudgetOutcome, UnPriceBudgetError>>
}

/** Where budgets read rate cards: a project's cards, each with every row, ended or not. */
export interface CardSource {
  /** Every card named, or CARD_NOT_FOUND for the first the project does not have. */
  read(
    projectId: string,
    cardIds: readonly string[]
  ): Promise<Result<CardRows[], UnPriceBudgetError>>
}

/** Where prepaid budgets reserve the money they lend locally: the payer's wallet (ADR-0008 D10). */
export interface BudgetWallet {
  /**
   * Runs one pending intent. The wallet answers a replayed `seq` as it answered the first call.
   * Either way the intent stays pending on the budget, and the next command that needs it replays
   * it: an error a replay answers the same way (a reservation the wallet no longer has, a payload
   * it refuses) comes back as `Err`, and a failure a replay may clear throws.
   */
  run(address: BudgetAddress, work: FundingWork): Promise<Result<FundingResult, UnPriceWalletError>>
}
