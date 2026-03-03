import * as currencies from "dinero.js/currencies"
import { type Interval, prepareInterval, statsSchema } from "@unprice/analytics"
import { currencySymbol } from "@unprice/db/utils"
import { calculateFlatPricePlan } from "@unprice/db/validators"
import { add, dinero, toDecimal } from "dinero.js"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getOverviewStats = protectedProjectProcedure
  .input(
    z.object({
      interval: z.custom<Interval>(),
    })
  )
  .output(
    z.object({
      stats: statsSchema,
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const project_id = opts.ctx.project.id

    const interval = opts.input.interval
    const preparedInterval = prepareInterval(interval)

    try {
      const data = await opts.ctx.db.query.subscriptions.findMany({
        where: (table, { eq }) => eq(table.projectId, project_id),
        columns: {
          id: true,
        },
        with: {
          customer: {
            columns: {
              id: true,
            },
          },
          phases: {
            columns: {
              id: true,
            },
            with: {
              planVersion: {
                with: {
                  planFeatures: {
                    with: {
                      feature: true,
                    },
                  },
                },
              },
            },
            where: (table, { lte, and, isNull, gte, or }) =>
              and(
                gte(table.startAt, preparedInterval.start),
                or(isNull(table.endAt), lte(table.endAt, preparedInterval.end))
              ),
          },
        },
      })

      // for now I want to get:
      // - new signups in the current billing period
      // - total revenue in the current billing period
      // - subscriptions churn in the current billing period
      // - number of active plans in the current billing period

      const defaultDineroCurrency = currencies[opts.ctx.project.defaultCurrency]

      let total = dinero({ amount: 0, currency: defaultDineroCurrency })

      const stats = {
        newSignups: {
          total: 0,
          title: "New Signups",
          description: `in the last ${preparedInterval.label}`,
        },
        totalRevenue: {
          total: 0,
          title: "Total Revenue",
          description: `in the last ${preparedInterval.label}`,
          unit: currencySymbol(opts.ctx.project.defaultCurrency),
        },
        newSubscriptions: {
          total: 0,
          title: "New Subscriptions",
          description: `in the last ${preparedInterval.label}`,
        },
        newCustomers: {
          total: 0,
          title: "New Customers",
          description: `in the last ${preparedInterval.label}`,
        },
      }

      for (const subscription of data) {
        // TODO: here there could be the case where the plans have multiple currencies
        // we should handle this case
        const planVersion = subscription.phases[0]?.planVersion

        if (!planVersion) {
          continue
        }

        const { err, val } = calculateFlatPricePlan({
          planVersion,
          prorate: 1,
        })

        if (err) {
          console.error(err)
          continue
        }

        const price = val.dinero

        stats.newSignups.total += 1
        total = add(total, price)
        stats.newSubscriptions.total += 1
        stats.newCustomers.total += 1
      }

      const displayAmount = toDecimal(total, ({ value }) => Number(value))
      stats.totalRevenue.total = displayAmount

      return { stats }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch overview stats"
      opts.ctx.logger.error(message, {
        project_id,
        interval,
      })

      return { stats: {}, error: message }
    }
  })
