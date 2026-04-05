import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const getByEmail = protectedProjectProcedure
  .input(customerSelectSchema.pick({ email: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .query(async (opts) => {
    const { email } = opts.input
    const project = opts.ctx.project
    const { customers } = opts.ctx.services

    const { err, val: customerData } = await customers.getCustomerByEmail({
      projectId: project.id,
      email,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!customerData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return {
      customer: customerData,
    }
  })
