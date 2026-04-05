import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const getById = protectedWorkspaceProcedure
  .input(z.object({ id: z.string() }))
  .output(
    z.object({
      project: projectSelectBaseSchema.extend({
        workspace: workspaceSelectBase,
      }),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const { projects } = opts.ctx.services

    const { err, val: projectData } = await projects.getProjectByIdInWorkspace({
      workspaceId: workspace.id,
      projectId: opts.input.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!projectData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Project not found",
      })
    }

    return {
      project: projectData,
    }
  })
