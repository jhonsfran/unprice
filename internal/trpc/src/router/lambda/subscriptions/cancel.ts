import { TRPCError } from "@trpc/server"
import { subscriptionSelectSchema, subscriptionStatusSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const cancel = protectedProjectProcedure
  .input(
    subscriptionSelectSchema.pick({ id: true, metadata: true }).extend({
      endAt: z.number().optional(),
    })
  )
  .output(z.object({ status: subscriptionStatusSchema, message: z.string() }))
  .mutation(async (opts) => {
    // only owner and admin can cancel a subscription
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await opts.ctx.services.subscriptions.cancelSubscription({
      subscriptionId: opts.input.id,
      projectId: opts.ctx.project.id,
      endAt: opts.input.endAt,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      status: val.status,
      message: "Subscription canceled successfully",
    }
  })
