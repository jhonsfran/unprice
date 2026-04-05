import { TRPCError } from "@trpc/server"
import {
  customerSelectSchema,
  featureSelectBaseSchema,
  invoiceItemSelectSchema,
  planSelectBaseSchema,
  planVersionFeatureSelectBaseSchema,
  planVersionSelectBaseSchema,
  selectBillingPeriodSchema,
  subscriptionInvoiceSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const getInvoiceByIdOutputSchema = z.object({
  invoice: subscriptionInvoiceSelectSchema.extend({
    customer: customerSelectSchema,
    subscription: subscriptionSelectSchema,
    invoiceItems: invoiceItemSelectSchema
      .extend({
        billingPeriod: selectBillingPeriodSchema.nullable(),
        featurePlanVersion: planVersionFeatureSelectBaseSchema
          .extend({
            feature: featureSelectBaseSchema,
            planVersion: planVersionSelectBaseSchema.extend({
              plan: planSelectBaseSchema,
            }),
          })
          .nullable(),
      })
      .array(),
  }),
})

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
    const { customers } = opts.ctx.services

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

    return getInvoiceByIdOutputSchema.parse({
      invoice,
    })
  })
