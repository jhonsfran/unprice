import type { ApiKeyExtended } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import {
  type BudgetBalance,
  type BudgetInspectQuery,
  type BudgetOutcome,
  type UnPriceBudgetError,
  definesBudget,
} from "@unprice/services/budgets"
import {
  type BudgetAddress,
  type BudgetVerbRequest,
  executeBudgetCommand,
  payerBudgetKey,
} from "@unprice/services/use-cases"
import type { Context } from "hono"
import { setMetric } from "hono/timing"
import { keyAuth, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { budgetRejectionError } from "~/errors/budget"
import type { HonoEnv } from "~/hono/env"
import { requestBudgetCommandDeps } from "~/ingestion/budget/deps"

export const BUDGET_REMAINING_HEADER = "Unprice-Budget-Remaining"

/**
 * Keys Unprice writes itself: a customer's subscription budget is `unprice:customer:<customerId>`
 * (ADR-0008 D1). A public call may read and spend under one, never create or define it.
 */
export const RESERVED_KEY_PREFIX = "unprice:"

/**
 * Runs one verb against the budget at `key` and sets the remaining header. Authenticates a runtime
 * key unless the route already authenticated `apiKey` itself. Returns the verb's outcome, or
 * throws the HTTP error its rejection maps to.
 */
export async function runBudgetVerb<R extends BudgetVerbRequest>(
  c: Context<HonoEnv>,
  key: string,
  request: R,
  apiKey?: Pick<ApiKeyExtended, "projectId" | "defaultCustomerId">
) {
  const { projectId, defaultCustomerId } = apiKey ?? (await keyAuth(c))
  const payerPrefix = payerBudgetKey("")
  if (key.startsWith(payerPrefix)) {
    resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: key.slice(payerPrefix.length),
      defaultCustomerId,
    })
  }
  if (definesBudget(request) && key.startsWith(RESERVED_KEY_PREFIX)) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: `Keys starting with ${RESERVED_KEY_PREFIX} are written by Unprice; a call cannot create or upsert one`,
    })
  }
  const result = await callBudget(
    c,
    request.type,
    () => executeBudgetCommand(budgetCommandDeps(c), { projectId, key, request }),
    resultOutcome
  )
  if (result.err) throw budgetApiError(c, result.err)
  setBudgetRemaining(c, result.val)
  return result.val
}

/**
 * What `executeBudgetCommand` needs in the API worker: the budget's Durable Object, the card source
 * and wallet for a refresh or a prepaid reserve, and the catalog for new budget facts.
 */
export function budgetCommandDeps(
  c: Context<HonoEnv>
): ReturnType<typeof requestBudgetCommandDeps> {
  return requestBudgetCommandDeps(c)
}

/**
 * Inspects the budget at `address` for the dashboard and reports the call like a verb. Returns the
 * inspection, or throws the HTTP error its rejection maps to.
 */
export async function inspectBudget(
  c: Context<HonoEnv>,
  address: BudgetAddress,
  query: BudgetInspectQuery
) {
  const { budgets } = budgetCommandDeps(c)
  const result = await callBudget(
    c,
    "inspect",
    () => budgets.inspect(address, query),
    resultOutcome
  )
  if (result.err) throw budgetApiError(c, result.err)
  return result.val
}

/**
 * How a budget call went, for the wide event: `outcome` is "ok" or the rejection code. A call that
 * carries a batch counts each event's outcome in `outcomes`; its `outcome` is the one they share,
 * or "mixed".
 */
export type BudgetCallOutcome = Readonly<{ outcome: string; outcomes?: Record<string, number> }>

const resultOutcome = (result: Result<unknown, UnPriceBudgetError>): BudgetCallOutcome => ({
  outcome: result.err ? result.err.rejection.code : "ok",
})

/** The outcome of a batch from each event's outcome. */
export function batchOutcome(outcomes: readonly string[]): BudgetCallOutcome {
  const counts: Record<string, number> = {}
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1
  const distinct = Object.keys(counts)
  return { outcome: distinct.length === 1 ? (distinct[0] as string) : "mixed", outcomes: counts }
}

/**
 * Runs budget work (one call on a budget's Durable Object, or a batch of them) and reports it once
 * on the request's wide event (`budget_*` in Axiom) and on Server-Timing as `budget`. Timed by
 * hand, apart from key auth and the rest of the Worker; a thrown call reports outcome "error".
 */
export async function callBudget<T>(
  c: Context<HonoEnv>,
  command: string,
  call: () => Promise<T>,
  outcomeOf: (value: T) => BudgetCallOutcome
): Promise<T> {
  const startedAt = performance.now()
  let reported: BudgetCallOutcome = { outcome: "error" }
  try {
    const value = await call()
    reported = outcomeOf(value)
    return value
  } finally {
    const doMs = performance.now() - startedAt
    setMetric(c, "budget", doMs)
    c.get("logger").set({ budget: { command, ...reported, do_ms: doMs } })
  }
}

/** The HTTP error a budget rejection maps to; a denial also sets the remaining header. */
export function budgetApiError(c: Context<HonoEnv>, error: UnPriceBudgetError): UnpriceApiError {
  if (error.rejection.code === "LIMIT_EXCEEDED") setBudgetRemaining(c, error.rejection)
  return budgetRejectionError(error)
}

export function setBudgetRemaining(
  c: Context<HonoEnv>,
  carrier: BudgetOutcome | { balance: BudgetBalance }
) {
  const balance =
    "budget" in carrier ? carrier.budget.balance : "balance" in carrier ? carrier.balance : null
  if (!balance) return
  c.header(
    BUDGET_REMAINING_HEADER,
    balance.remaining === null ? "unlimited" : formatAmount(balance.remaining)
  )
}
