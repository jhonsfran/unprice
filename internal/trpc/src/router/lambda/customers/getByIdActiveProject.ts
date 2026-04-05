import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const getByIdActiveProject = protectedProjectProcedure
  .meta({
    span: "customers.getByIdActiveProject",
    openapi: {
      method: "GET",
      path: "/lambda/customers.getByIdActiveProject",
      protect: true,
    },
  })
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .query(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    const { err, val: customerData } = await customers.getCustomerByIdInProject({
      id,
      projectId: project.id,
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
