import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { projectInsertBaseSchema, projectSelectBaseSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(projectInsertBaseSchema.required({ id: true }))
  .output(
    z.object({
      project: projectSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id, name, defaultCurrency, timezone, url, contactEmail } = opts.input
    const _workspace = opts.ctx.project.workspace
    const { projects } = opts.ctx.services

    // only owner and admin can update a plan
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await projects.updateProjectRecord({
      id,
      name,
      defaultCurrency,
      timezone,
      url,
      contactEmail,
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
        message: "project not found",
      })
    }

    return {
      project: val.project,
    }
  })
