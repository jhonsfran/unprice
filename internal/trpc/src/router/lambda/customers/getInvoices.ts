import { TRPCError } from "@trpc/server"
import { customerSelectSchema, subscriptionInvoiceSelectSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const getInvoicesOutputSchema = z.object({
  customer: customerSelectSchema.extend({
    invoices: subscriptionInvoiceSelectSchema.array(),
  }),
})

export const getInvoices = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getInvoicesOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const { err, val: customerWithSubscriptions } = await customers.getCustomerInvoices({
      customerId,
      projectId: project.id,
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

    return getInvoicesOutputSchema.parse({
      customer: customerWithSubscriptions,
    })
  })
