import { TRPCError } from "@trpc/server"
import { eventSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(z.void())
  .output(z.object({ events: z.array(eventSelectBaseSchema) }))
  .query(async (opts) => {
    const project = opts.ctx.project
    const { events: eventService } = opts.ctx.services

    const { err, val: events } = await eventService.listEventsByProject({
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      events,
    }
  })
