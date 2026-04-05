import { subscriptionInsertSchema, subscriptionSelectSchema } from "@unprice/db/validators"
import { createSubscription } from "@unprice/services/use-cases"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(subscriptionInsertSchema)
  .output(
    z.object({
      subscription: subscriptionSelectSchema,
    })
  )
  .mutation(async (opts) => {
    const { phases, ...rest } = opts.input
    // only owner and admin can create a subscription
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // create the subscription
    const { err, val } = await createSubscription(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        input: rest,
        projectId: opts.ctx.project.id,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      subscription: val,
    }
  })
