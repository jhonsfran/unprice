import { subscriptionInsertSchema, subscriptionSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"
import { createTRPCServices } from "../../../utils/services"

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

    const { subscriptions } = createTRPCServices(opts.ctx)

    // create the subscription
    const { err, val } = await subscriptions.createSubscription({
      input: rest,
      projectId: opts.ctx.project.id,
    })

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
