import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const remove = protectedProjectProcedure
  .meta({
    span: "customers.remove",
    openapi: {
      method: "POST",
      path: "/lambda/customers.remove",
      protect: true,
    },
  })
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services
    const _unPriceCustomerId = project.workspace.unPriceCustomerId

    const { val, err } = await customers.removeCustomerRecord({
      projectId: project.id,
      id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return {
      customer: val.customer,
    }
  })
