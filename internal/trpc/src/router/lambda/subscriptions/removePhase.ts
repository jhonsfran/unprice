import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { createTRPCServices } from "../../../utils/services"

export const removePhase = protectedProjectProcedure
  .input(z.object({ id: z.string() }))
  .output(z.object({ result: z.boolean() }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id
    const { subscriptions } = createTRPCServices(opts.ctx)

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
