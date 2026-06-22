import { TRPCError } from "@trpc/server"
import { getCustomerWallet, getCustomerWalletOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getWallet = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getCustomerWalletOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { err, val } = await getCustomerWallet(
      {
        services: {
          customers: opts.ctx.services.customers,
          wallet: opts.ctx.services.wallet,
        },
        logger: opts.ctx.logger,
      },
      {
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

    return getCustomerWalletOutputSchema.parse(val)
  })
