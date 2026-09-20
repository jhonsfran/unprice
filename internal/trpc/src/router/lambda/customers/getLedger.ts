import { TRPCError } from "@trpc/server"
import { searchParamsSchemaDataTable } from "@unprice/db/validators"
import { getCustomerLedger, getCustomerLedgerOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getLedger = protectedProjectProcedure
  .input(
    searchParamsSchemaDataTable.extend({
      customerId: z.string(),
    })
  )
  .output(getCustomerLedgerOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { err, val } = await getCustomerLedger(
      {
        services: {
          customers: opts.ctx.services.customers,
          customerLedger: opts.ctx.services.customerLedger,
        },
        logger: opts.ctx.logger,
      },
      {
        ...opts.input,
        projectId: project.id,
        customerId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return val
  })
