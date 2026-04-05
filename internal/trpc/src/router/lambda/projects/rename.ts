import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, renameProjectSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const rename = protectedProjectProcedure
  .input(renameProjectSchema)
  .output(
    z.object({
      project: projectSelectBaseSchema.optional(),
    })
  )
  .mutation(async (opts) => {
    const { name } = opts.input
    const project = opts.ctx.project
    const { projects } = opts.ctx.services

    // only owner and admin can rename a project
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await projects.updateProjectRecord({
      id: project.id,
      name,
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
        message: "Project not found",
      })
    }

    return {
      project: val.project,
    }
  })
