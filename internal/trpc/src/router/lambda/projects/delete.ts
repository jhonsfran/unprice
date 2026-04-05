import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const deleteProject = protectedProjectProcedure
  .input(
    z.object({
      projectId: z.string().optional(),
      projectSlug: z.string().optional(),
    })
  )
  .output(
    z.object({
      project: projectSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const project = opts.ctx.project
    const { projects } = opts.ctx.services

    // only owner can delete a project
    opts.ctx.verifyRole(["OWNER"])

    const { val, err } = await projects.deleteProjectRecord({
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "main_project_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot delete main project",
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Project not found",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting project",
      })
    }

    return {
      project: val.project,
    }
  })
