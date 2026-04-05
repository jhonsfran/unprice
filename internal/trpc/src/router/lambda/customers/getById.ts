import { customerSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProcedure } from "#trpc"

// this is a global method which is used by the frontend to get a customer by id for any project
export const getById = protectedProcedure
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .query(async (opts) => {
    const { id } = opts.input

    const { err, val: customerData } = await opts.ctx.services.customers.getCustomer(id)

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
