import { TRPCError } from "@trpc/server"
import { eventSelectBaseSchema, eventUpdateBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(eventUpdateBaseSchema)
  .output(z.object({ event: eventSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id, name, availableProperties } = opts.input
    const project = opts.ctx.project
    const { events: eventService } = opts.ctx.services
    const hasAvailableProperties = Object.prototype.hasOwnProperty.call(
      opts.input,
      "availableProperties"
    )

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await eventService.updateEvent({
      projectId: project.id,
      id,
      name,
      availableProperties,
      hasAvailableProperties,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Event not found",
      })
    }

    return { event: val.event }
  })
