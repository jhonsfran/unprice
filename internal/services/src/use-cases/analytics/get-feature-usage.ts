import { unitSpendingSchema } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { formatAmount, spendingOf } from "@unprice/money"
import { z } from "zod"
import { customerOfKey, featureUsageQuery, splitOverflow } from "../../analytics/budget-journal"
import type { ServiceContext } from "../../context"

export const getFeatureUsageInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().optional(),
  window: z.object({ from: z.date(), to: z.date() }),
  byCustomer: z.boolean(),
})
export const getFeatureUsageOutputSchema = z.object({
  rows: z.array(
    z.object({
      customerId: z.string().optional(),
      featureSlug: z.string(),
      usage: z.number(),
      spending: unitSpendingSchema,
    })
  ),
  truncatedEvents: z.number().int().nonnegative(),
})
export type GetFeatureUsageOutput = z.infer<typeof getFeatureUsageOutputSchema>

export async function getFeatureUsage(
  deps: Pick<ServiceContext, "budgetJournal">,
  rawInput: z.infer<typeof getFeatureUsageInputSchema>
): Promise<Result<GetFeatureUsageOutput, FetchError>> {
  const input = getFeatureUsageInputSchema.parse(rawInput)
  const result = await deps.budgetJournal.read(featureUsageQuery(input))
  if (result.err) return Err(result.err)
  const { rows, truncatedEvents } = splitOverflow(result.val)
  return Ok({
    rows: rows.map((row) => {
      const customerId = row.budget_key ? customerOfKey(row.budget_key) : null
      return {
        ...(customerId ? { customerId } : {}),
        featureSlug: row.feature_slug,
        usage: Number(formatAmount(row.quantity)),
        spending: spendingOf(row.amount, row.unit),
      }
    }),
    truncatedEvents,
  })
}
