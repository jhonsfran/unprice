import { Err, Ok, type Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import { z } from "zod"
import type { UnPriceBudgetError } from "../../budgets"
import type { BudgetClient } from "../budgets/budget-client"
import { quantity } from "../budgets/payer-access"
import { readPayerBudget } from "../budgets/read-payer-budget"

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
  budgets: Pick<BudgetClient, "execute">
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
  const payer = await readPayerBudget(deps.budgets, input, { statements: true })
  if (payer.err) return Err(payer.err)
  if (!payer.val) return Ok({ billingPeriods: [] })
  const unit = payer.val.budget.unit
  const periods = new Map<string, z.infer<typeof currentBillingPeriodUsageSchema>>()
  for (const statement of payer.val.statements) {
    const current = statement.state === "open" && statement.start <= now && now < statement.end
    if (!current) continue
    const id = statement.periodId
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
