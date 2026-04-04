import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"


export const removePhase = protectedProjectProcedure
  .input(z.object({ id: z.string() }))
  .output(z.object({ result: z.boolean() }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id
    const { subscriptions } = opts.ctx.services

    const { err, val } = await subscriptions.removePhase({
      phaseId: opts.input.id,
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
      result: val,
    }
  })
