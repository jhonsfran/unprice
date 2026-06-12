import { analyticsIntervalSchema, prepareInterval } from "@unprice/analytics"
import { inArray } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import type { Currency } from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { TIMEOUTS, withTimeout } from "#utils/timeout"

const topConsumerOutputSchema = z.object({
  customerId: z.string(),
  email: z.string(),
  name: z.string(),
  totalUsage: z.number(),
  displaySpending: z.string(),
})

export type TopConsumerOutput = z.infer<typeof topConsumerOutputSchema>

export const getTopConsumers = protectedProjectProcedure
  .input(
    z.object({
      range: analyticsIntervalSchema,
      limit: z.number().min(1).max(20).optional().default(10),
    })
  )
  .output(
    z.object({
      consumers: topConsumerOutputSchema.array(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const range = opts.input.range
    const limit = opts.input.limit
    const projectId = opts.ctx.project.id
    const { start, end } = prepareInterval(range)
    const cacheKey = `top-consumers:${projectId}:${range}:${limit}`

    const { err, val: cached } = await opts.ctx.cache.getTopConsumers.swr(cacheKey, async () => {
      const data = await withTimeout(
        opts.ctx.analytics.getTopConsumers({
          project_id: projectId,
          start,
          end,
          limit,
        }),
        TIMEOUTS.ANALYTICS,
        "getTopConsumers analytics request timeout"
      )

      const rows = data.data ?? []

      if (rows.length === 0) {
        return []
      }

      // Batch lookup customer emails from DB
      const customerIds = rows.map((r) => r.customer_id)
      const customerRecords = await opts.ctx.db
        .select({ id: customers.id, email: customers.email, name: customers.name })
        .from(customers)
        .where(inArray(customers.id, customerIds))

      const customerMap = new Map(customerRecords.map((c) => [c.id, c]))

      return rows
        .map((row) => {
          const customer = customerMap.get(row.customer_id)

          if (!customer) {
            return null
          }

          const currency = (row.currency ?? "USD") as Currency
          const rawAmount = row.total_amount_after ?? 0
          const decimalAmount = Number.parseFloat(
            toDecimal(fromLedgerMinor(rawAmount, currency))
          ).toFixed(2)

          return {
            customerId: row.customer_id,
            email: customer.email,
            name: customer.name,
            totalUsage: row.total_usage ?? 0,
            displaySpending: formatMoney(decimalAmount, currency),
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
    })

    if (err) {
      opts.ctx.logger.error(err, {
        context: "getTopConsumers failed",
        project_id: projectId,
        range,
      })

      return {
        consumers: [],
        error: err instanceof Error ? err.message : "Failed to fetch top consumers",
      }
    }

    return { consumers: cached ?? [] }
  })
