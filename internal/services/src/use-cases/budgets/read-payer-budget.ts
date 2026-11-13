import { Err, Ok, type Result } from "@unprice/error"
import type { BudgetSnapshot, Statement, UnPriceBudgetError } from "../../budgets"
import { isOutcomeOf } from "../../budgets"
import { payerBudgetKey } from "../../budgets/payer-key"
import type { BudgetClient } from "./budget-client"

export type PayerBudgetView = Readonly<{ budget: BudgetSnapshot; statements: readonly Statement[] }>

/** Missing budgets answer null. Each caller decides how to handle other failures. */
export async function readPayerBudget(
  budgets: Pick<BudgetClient, "execute">,
  ids: { projectId: string; customerId: string },
  options: { statements: boolean }
): Promise<Result<PayerBudgetView | null, UnPriceBudgetError>> {
  const address = { projectId: ids.projectId, key: payerBudgetKey(ids.customerId) }
  const [got, listed] = await Promise.all([
    budgets.execute(address, { type: "get" }),
    options.statements ? budgets.execute(address, { type: "statements" }) : null,
  ])
  const failure = got.err ?? listed?.err
  if (failure) return failure.rejection.code === "BUDGET_NOT_FOUND" ? Ok(null) : Err(failure)
  if (
    !got.val ||
    !isOutcomeOf(got.val, "get") ||
    (listed && (!listed.val || !isOutcomeOf(listed.val, "statements")))
  ) {
    throw new Error("payer budget answered another verb")
  }
  return Ok({
    budget: got.val.budget,
    statements: listed?.val && isOutcomeOf(listed.val, "statements") ? listed.val.statements : [],
  })
}
