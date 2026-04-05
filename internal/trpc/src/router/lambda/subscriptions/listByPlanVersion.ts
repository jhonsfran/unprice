import { TRPCError } from "@trpc/server"
import { subscriptionSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const listByPlanVersion = protectedProjectProcedure
  .input(z.object({ planVersionId: z.string() }))
  .output(
    z.object({
      subscriptions: z.array(subscriptionSelectSchema),
    })
  )
  .query(async (opts) => {
    const { planVersionId } = opts.input
    const project = opts.ctx.project
    const { subscriptions } = opts.ctx.services

    const { err, val: subscriptionData } = await subscriptions.listSubscriptionsByPlanVersion({
      planVersionId,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!subscriptionData || subscriptionData.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Subscription not found. Please check the planVersionId",
      })
    }

    return {
      subscriptions: subscriptionData,
    }
  })
