import { TRPCError } from "@trpc/server"
import {
  customerSelectSchema,
  searchParamsSchemaDataTable,
  subscriptionInvoiceSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const getInvoicesOutputSchema = z.object({
  customer: customerSelectSchema,
  invoices: subscriptionInvoiceSelectSchema.array(),
  pageCount: z.number(),
})

export const getInvoices = protectedProjectProcedure
  .input(
    searchParamsSchemaDataTable.extend({
      customerId: z.string(),
    })
  )
  .output(getInvoicesOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const { err, val: customerInvoices } = await customers.getCustomerInvoices({
      customerId,
      projectId: project.id,
      query: opts.input,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!customerInvoices) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return getInvoicesOutputSchema.parse({
      customer: customerInvoices.customer,
      invoices: customerInvoices.invoices,
      pageCount: customerInvoices.pageCount,
    })
  })
