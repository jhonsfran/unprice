import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import {
  type BudgetDefinition,
  type BudgetOutcome,
  type FundingNeed,
  type FundingWork,
  type OutcomeOf,
  UnPriceBudgetError,
  catalogFactsOf,
  isOutcomeOf,
} from "../../budgets"
import type { ServiceContext } from "../../context"
import type { WalletErrorCode } from "../../wallet"
import type {
  BudgetAddress,
  BudgetClient,
  BudgetRequest,
  BudgetWallet,
  CardSource,
} from "./budget-client"

/** The budget a verb creates when its key has none, before the address is added to it. */
export type BudgetDefinitionInput = Omit<BudgetDefinition, "key" | "projectId">

type Addressed<T> = T extends { ifMissing?: BudgetDefinition }
  ? Omit<T, "ifMissing"> & { ifMissing?: BudgetDefinitionInput }
  : T

/**
 * A verb as an adapter receives it, already parsed by the `@unprice/db/validators` schemas. The
 * key travels beside it: an upsert takes its key and project from the address, and so does the
 * `ifMissing` definition of a verb that creates its budget on first use.
 */
export type BudgetVerbRequest =
  | Omit<Extract<BudgetRequest, { type: "upsert" }>, "key" | "projectId">
  | Addressed<Exclude<BudgetRequest, { type: "upsert" }>>

export type ExecuteBudgetCommandDeps = {
  budgets: Pick<BudgetClient, "execute">
  cards: CardSource
  /** Called only for a prepaid budget's funding; a postpaid budget never reaches it. */
  wallet: BudgetWallet
  services: Pick<ServiceContext, "budgetCatalog">
  logger: Logger
  waitUntil: (promise: Promise<unknown>) => void
}

export type ExecuteBudgetCommandInput<R extends BudgetVerbRequest = BudgetVerbRequest> = {
  projectId: string
  key: string
  request: R
}

function toCommand(request: BudgetVerbRequest, projectId: string, key: string): BudgetRequest {
  if (request.type === "upsert") return { ...request, key, projectId }
  if ("ifMissing" in request && request.ifMissing) {
    return { ...request, ifMissing: { ...request.ifMissing, key, projectId } }
  }
  return request as BudgetRequest
}

/**
 * The one owner of every budget verb: the API routes call it now, ingestion `record` and
 * subscription-created budgets later. An upsert always configures the budget at the address it
 * is sent to. Configured or newly created budget facts reach the catalog through `waitUntil`.
 */
export async function executeBudgetCommand<R extends BudgetVerbRequest>(
  deps: ExecuteBudgetCommandDeps,
  input: ExecuteBudgetCommandInput<R>
): Promise<Result<OutcomeOf<R["type"]>, UnPriceBudgetError>> {
  const { projectId, key } = input
  const command = toCommand(input.request, projectId, key)
  const address = { projectId, key }
  let result = await deps.budgets.execute(address, command)
  // Each refusal below wrote nothing: resolve it once and send the command again.
  let refreshed = false
  let funded = false
  for (;;) {
    const rejection = result.err?.rejection
    if (rejection?.code === "CARDS_STALE" && !refreshed) {
      refreshed = true
      const cards = await deps.cards.read(projectId, rejection.cardIds)
      if (cards.err) return cards
      result = await deps.budgets.execute(address, command, cards.val)
      continue
    }
    if (rejection?.code === "FUNDING_REQUIRED" && !funded) {
      funded = true
      const reserved = await fund(deps, address, rejection.needs)
      if (reserved.err) return reserved
    } else {
      break
    }
    result = await deps.budgets.execute(address, command)
  }
  // The wallet granted what it could and the budget still cannot cover the usage.
  if (result.err?.rejection.code === "FUNDING_REQUIRED") {
    const [need] = result.err.rejection.needs
    if (!need) throw new Error("FUNDING_REQUIRED named no statement")
    return Err(new UnPriceBudgetError({ code: "WALLET_EMPTY", ...need }))
  }
  if (result.err) return result
  // RPC erases the verb's type; the budget always answers with the outcome of the verb it ran.
  if (!isOutcomeOf(result.val, input.request.type)) {
    throw new Error(`budget ${input.request.type} returned a ${result.val.type} outcome`)
  }
  const outcome = result.val
  // A seal leaves its key's close pending; billing retries the seal to replay a close that failed.
  if (outcome.type === "sealStatements") {
    const drained = await drain(deps, address, outcome.funding)
    if (drained.err) return drained
  }
  const budget =
    outcome.type === "upsert"
      ? outcome.changes.length > 0 || outcome.budget.version === 1
        ? outcome.budget
        : null
      : "created" in outcome
        ? outcome.created
        : null
  if (budget) {
    deps.waitUntil(
      deps.services.budgetCatalog
        .record(projectId, catalogFactsOf(budget))
        .catch((error: unknown) => {
          deps.logger.error(error instanceof Error ? error : new Error(String(error)), {
            context: "budget catalog write failed",
            projectId,
            version: budget.version,
          })
        })
    )
  }
  return Ok(outcome)
}

type FundingDeps = Pick<ExecuteBudgetCommandDeps, "budgets" | "wallet" | "logger">

/** Reserves from the wallet for every statement key a charge or hold could not fund. */
async function fund(
  deps: FundingDeps,
  address: BudgetAddress,
  needs: readonly FundingNeed[]
): Promise<Result<void, UnPriceBudgetError>> {
  for (const { statementKey, required } of needs) {
    const intent = await deps.budgets.execute(address, { type: "fund", statementKey, required })
    if (intent.err) return intent
    const drained = await drain(deps, address, fundingOf(intent.val, "fund"))
    if (drained.err) return drained
  }
  return Ok(undefined)
}

/**
 * Runs each pending intent against the wallet and applies what it returned, then the intent that
 * follows it (a reserve that lands after its key sealed is followed by the close). The budget
 * persisted every intent first, so a failure here leaves it pending for a replay. A wallet that
 * refuses the intent refuses every replay too, so the refusal is logged for an operator and
 * answered as FUNDING_FAILED.
 */
async function drain(
  deps: FundingDeps,
  address: BudgetAddress,
  work: readonly FundingWork[]
): Promise<Result<void, UnPriceBudgetError>> {
  const queue = [...work]
  for (let next = queue.shift(); next; next = queue.shift()) {
    const ran = await deps.wallet.run(address, next)
    if (ran.err) {
      const error = ran.err
      // UnPriceWalletError's constructor takes only a WalletErrorCode as its message.
      const walletCode = error.message as WalletErrorCode
      const { statementKey, intent, customerId } = next
      deps.logger.error(error, {
        context: "budget funding failed: the wallet refused a pending intent",
        project_id: address.projectId,
        budget_key: address.key,
        customer_id: customerId,
        statement_key: statementKey,
        intent: intent.kind,
        seq: intent.seq,
        wallet_code: walletCode,
      })
      return Err(
        new UnPriceBudgetError({
          code: "FUNDING_FAILED",
          statementKey,
          seq: intent.seq,
          intent: intent.kind,
          walletCode,
        })
      )
    }
    const applied = await deps.budgets.execute(address, {
      type: "applyFunding",
      statementKey: next.statementKey,
      seq: next.intent.seq,
      result: ran.val,
    })
    if (applied.err) return applied
    queue.push(...fundingOf(applied.val, "applyFunding"))
  }
  return Ok(undefined)
}

function fundingOf(outcome: BudgetOutcome, type: "fund" | "applyFunding") {
  if (!isOutcomeOf(outcome, type)) throw new Error(`budget ${type} returned a ${outcome.type}`)
  return outcome.funding
}
