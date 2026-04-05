import { TRPCError } from "@trpc/server"
import {
  subscriptionPhaseInsertSchema,
  subscriptionPhaseSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const createPhase = protectedProjectProcedure
  .input(subscriptionPhaseInsertSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async ({ input, ctx }) => {
    const projectId = ctx.project.id
    const { subscriptions } = ctx.services

    const { err, val } = await subscriptions.createPhase({
      input,
      projectId,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      phase: val,
    }
  })
