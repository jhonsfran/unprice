import { TRPCError } from "@trpc/server"
import { eventInsertBaseSchema, eventSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(eventInsertBaseSchema)
  .output(z.object({ event: eventSelectBaseSchema }))
  .mutation(async (opts) => {
    const { name, slug, availableProperties } = opts.input
    const project = opts.ctx.project
    const { events: eventService } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: event, err } = await eventService.createEvent({
      projectId: project.id,
      name,
      slug,
      availableProperties,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return { event }
  })
