import { TRPCError } from "@trpc/server"
import {
  customerSelectSchema,
  subscriptionInvoiceSelectSchema,
  subscriptionPhaseSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const getSubscriptionsOutputSchema = z.object({
  customer: customerSelectSchema
    .extend({
      subscriptions: subscriptionSelectSchema
        .extend({
          customer: customerSelectSchema,
          phases: subscriptionPhaseSelectSchema.array(),
        })
        .array(),
    })
    .extend({
      invoices: subscriptionInvoiceSelectSchema.array(),
    }),
})

export const getSubscriptions = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getSubscriptionsOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const { err, val: customerWithSubscriptions } = await customers.getCustomerSubscriptions({
      customerId,
      projectId: project.id,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!customerWithSubscriptions) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return getSubscriptionsOutputSchema.parse({
      customer: customerWithSubscriptions,
    })
  })
