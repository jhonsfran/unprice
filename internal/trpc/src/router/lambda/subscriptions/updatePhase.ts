import {
  subscriptionPhaseSelectSchema,
  subscriptionPhaseUpdateSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { updatePhaseErrorToTrpcError } from "./updatePhase-errors"

export const updatePhase = protectedProjectProcedure
  .input(subscriptionPhaseUpdateSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id
    const { subscriptions } = opts.ctx.services

    const { err, val } = await subscriptions.updatePhase({
      input: opts.input,
      projectId,
      subscriptionId: opts.input.subscriptionId,
      now: Date.now(),
    })

    if (err) {
      throw updatePhaseErrorToTrpcError(err)
    }

    return {
      phase: val,
    }
  })
