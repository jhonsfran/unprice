import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const bindCustomer = protectedProjectProcedure
  .input(
    z.object({
      apikeyId: z.string(),
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      success: z.boolean(),
    })
  )
  .mutation(async (opts) => {
    const { apikeyId, customerId } = opts.input
    const { project, services } = opts.ctx

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: customer, err: customerErr } = await services.customers.getCustomerByIdInProject({
      id: customerId,
      projectId: project.id,
    })

    if (customerErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: customerErr.message,
      })
    }

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found in project",
      })
    }

    const { val, err } = await services.apikeys.bindCustomer({
      apikeyId,
      customerId,
      projectId: project.id,
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
        message: "API key not found",
      })
    }

    return { success: true }
  })
