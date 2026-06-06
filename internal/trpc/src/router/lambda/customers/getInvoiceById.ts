import { TRPCError } from "@trpc/server"
import {
  currencySchema,
  customerSelectSchema,
  invoiceSettlementSourceSchema,
  invoiceSettlementStatusSchema,
  subscriptionInvoiceSelectSchema,
  subscriptionSelectSchema,
  walletCreditSourceSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const invoiceLineSchema = z.object({
  entryId: z.string(),
  statementKey: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  amount: z.number().int().nonnegative(),
  amountDue: z.number().int().nonnegative(),
  amountPaid: z.number().int().nonnegative(),
  amountIncluded: z.number().int().nonnegative(),
  collectable: z.boolean(),
  settlementSource: invoiceSettlementSourceSchema,
  settlementStatus: invoiceSettlementStatusSchema,
  walletCreditId: z.string().nullable(),
  walletCreditSource: walletCreditSourceSchema.nullable(),
  walletId: z.string().nullable(),
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
  currency: z.infer<typeof currencySchema>
  grossAmount: number
  amountDue: number
  amountPaid: number
  amountIncluded: number
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
    const { billing, customers } = opts.ctx.services

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
    const linesResult = await billing.getInvoiceStatementLines({
      projectId: invoiceRow.projectId,
      invoiceId,
      statementKey: invoiceRow.statementKey,
      currency: invoiceRow.currency as z.infer<typeof currencySchema>,
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
        grossAmount: invoiceRow.grossAmount,
        amountDue: invoiceRow.amountDue,
        amountPaid: invoiceRow.amountPaid,
        amountIncluded: invoiceRow.amountIncluded,
        lines: linesResult.val.map((line) => ({
          entryId: line.entryId,
          statementKey: line.statementKey,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amount: line.amount,
          amountDue: line.amountDue,
          amountPaid: line.amountPaid,
          amountIncluded: line.amountIncluded,
          collectable: line.collectable,
          settlementSource: line.settlementSource,
          settlementStatus: line.settlementStatus,
          walletCreditId: line.walletCreditId,
          walletCreditSource: line.walletCreditSource,
          walletId: line.walletId,
          currency: line.currency,
          createdAt: line.createdAt.toISOString(),
        })),
      },
    })
  })
