import {
  subscriptionPhaseSelectSchema,
  subscriptionPhaseUpdateSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

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
      throw domainErrorToTrpcError(err, "Failed to update subscription phase")
    }

    return {
      phase: val,
    }
  })
