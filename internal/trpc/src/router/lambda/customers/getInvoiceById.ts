import { TRPCError } from "@trpc/server"
import {
  currencySchema,
  customerSelectSchema,
  subscriptionInvoiceSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { toLedgerMinor } from "@unprice/money"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const invoiceLineSchema = z.object({
  entryId: z.string(),
  statementKey: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  amount: z.number().int().nonnegative(),
  currency: currencySchema,
  createdAt: z.string().datetime(),
})

const getInvoiceByIdOutputSchema = z.object({
  invoice: subscriptionInvoiceSelectSchema.extend({
    customer: customerSelectSchema,
    subscription: subscriptionSelectSchema,
    lines: invoiceLineSchema.array(),
  }),
})

type InvoiceWithRelations = {
  projectId: string
  statementKey: string
  [key: string]: unknown
}

export const getInvoiceById = protectedProjectProcedure
  .input(
    z.object({
      invoiceId: z.string(),
      customerId: z.string(),
    })
  )
  .output(getInvoiceByIdOutputSchema)
  .query(async (opts) => {
    const { invoiceId, customerId } = opts.input
    const { project } = opts.ctx
    const { customers, ledger } = opts.ctx.services

    const { err, val: invoice } = await customers.getInvoiceById({
      invoiceId,
      customerId,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!invoice) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Invoice not found",
      })
    }

    const invoiceRow = invoice as InvoiceWithRelations
    const linesResult = await ledger.getInvoiceLines({
      projectId: invoiceRow.projectId,
      statementKey: invoiceRow.statementKey,
    })

    if (linesResult.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: linesResult.err.message,
      })
    }

    return getInvoiceByIdOutputSchema.parse({
      invoice: {
        ...invoiceRow,
        lines: linesResult.val.map((line) => ({
          entryId: line.entryId,
          statementKey: line.statementKey,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amount: toLedgerMinor(line.amount),
          currency: line.currency,
          createdAt: line.createdAt.toISOString(),
        })),
      },
    })
  })
