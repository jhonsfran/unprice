import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const exist = protectedProjectProcedure
  .input(customerSelectSchema.pick({ email: true }))
  .output(z.object({ exist: z.boolean() }))
  .mutation(async (opts) => {
    const { email } = opts.input
    const project = opts.ctx.project
    const { customers } = opts.ctx.services

    const { err, val: exists } = await customers.customerExistsByEmail({
      projectId: project.id,
      email,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      exist: exists,
    }
  })
