import { TRPCError } from "@trpc/server"
import { subscriptionPhaseSelectSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { createTRPCServices } from "../../../utils/services"

export const updatePhase = protectedProjectProcedure
  .input(subscriptionPhaseSelectSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id
    const { subscriptions } = createTRPCServices(opts.ctx)

    const { err, val } = await subscriptions.updatePhase({
      input: opts.input,
      projectId,
      subscriptionId: opts.input.subscriptionId,
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
