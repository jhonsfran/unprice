import { Err, Ok, type Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import { z } from "zod"
import { type UnPriceBudgetError, isOutcomeOf } from "../../budgets"
import type { BudgetClient } from "../budgets/budget-client"
import { billingPeriodIdOf, payerBudgetKey } from "../budgets/compile-payer-budget"
import { quantity } from "../budgets/payer-access"

export const getCurrentBillingPeriodUsageInputSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
})

const currentBillingPeriodUsageSchema = z.object({
  /** The billing period the statements belong to. */
  id: z.string(),
  cycleStartAt: z.number().int(),
  cycleEndAt: z.number().int(),
  usage: z.array(
    z.object({
      featureSlug: z.string(),
      /** The metered quantity so far. */
      usage: z.number(),
      /** What that usage costs so far, priced at ingestion: a decimal in `unit`. */
      amount: z.string(),
      /** The payer budget's unit: money:<code>, credits:<id>, or units:<slug>. */
      unit: z.string(),
    })
  ),
})

export const getCurrentBillingPeriodUsageOutputSchema = z.object({
  billingPeriods: z.array(currentBillingPeriodUsageSchema),
})

export type GetCurrentBillingPeriodUsageInput = z.infer<
  typeof getCurrentBillingPeriodUsageInputSchema
>
export type GetCurrentBillingPeriodUsageOutput = z.infer<
  typeof getCurrentBillingPeriodUsageOutputSchema
>

export type GetCurrentBillingPeriodUsageDeps = {
  budgets: BudgetClient
  now?: () => number
}

/**
 * The customer's usage in the billing periods open now, live from the payer budget at
 * `unprice:customer:<customerId>` (ADR-0008 D1, D7): one statement per metered feature and
 * billing period, priced at ingestion. A customer without a payer budget has no metered usage.
 */
export async function getCurrentBillingPeriodUsage(
  deps: GetCurrentBillingPeriodUsageDeps,
  rawInput: GetCurrentBillingPeriodUsageInput
): Promise<Result<GetCurrentBillingPeriodUsageOutput, UnPriceBudgetError>> {
  const input = getCurrentBillingPeriodUsageInputSchema.parse(rawInput)
  const now = deps.now?.() ?? Date.now()
  const address = { projectId: input.projectId, key: payerBudgetKey(input.customerId) }

  const [got, statements] = await Promise.all([
    deps.budgets.execute(address, { type: "get" }),
    deps.budgets.execute(address, { type: "statements" }),
  ])
  const failure = got.err ?? statements.err
  if (failure) {
    return failure.rejection.code === "BUDGET_NOT_FOUND" ? Ok({ billingPeriods: [] }) : Err(failure)
  }
  if (
    !got.val ||
    !statements.val ||
    !isOutcomeOf(got.val, "get") ||
    !isOutcomeOf(statements.val, "statements")
  ) {
    throw new Error("payer budget answered another verb")
  }

  const unit = got.val.budget.unit
  const periods = new Map<string, z.infer<typeof currentBillingPeriodUsageSchema>>()
  for (const statement of statements.val.statements) {
    // The budget's own perpetual statements start with "#": billing registered none of them.
    const current = statement.state === "open" && statement.start <= now && now < statement.end
    if (!current || statement.periodId.startsWith("#")) continue
    const id = billingPeriodIdOf(statement.periodId)
    const period = periods.get(id) ?? {
      id,
      cycleStartAt: statement.start,
      cycleEndAt: statement.end,
      usage: [],
    }
    period.cycleStartAt = Math.min(period.cycleStartAt, statement.start)
    period.cycleEndAt = Math.max(period.cycleEndAt, statement.end)
    period.usage.push({
      featureSlug: statement.featureSlug,
      usage: quantity(statement.quantity),
      amount: formatAmount(statement.amount),
      unit,
    })
    periods.set(id, period)
  }

  return Ok(
    getCurrentBillingPeriodUsageOutputSchema.parse({
      billingPeriods: [...periods.values()]
        .map((period) => ({
          ...period,
          usage: period.usage.sort((a, b) => a.featureSlug.localeCompare(b.featureSlug)),
        }))
        .sort((a, b) => a.cycleStartAt - b.cycleStartAt || a.id.localeCompare(b.id)),
    })
  )
}
