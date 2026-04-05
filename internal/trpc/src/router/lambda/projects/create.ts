import { TRPCError } from "@trpc/server"
import { projectInsertBaseSchema, projectSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const create = protectedWorkspaceProcedure
  .input(projectInsertBaseSchema)
  .output(z.object({ project: projectSelectBaseSchema }))
  .mutation(async (opts) => {
    const { name, url, defaultCurrency, timezone, contactEmail } = opts.input
    const workspace = opts.ctx.workspace
    const defaultContactEmail = opts.ctx.session.user.email
    const { projects } = opts.ctx.services

    // only owner and admin can create a project
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: newProject, err } = await projects.createProjectRecord({
      workspaceId: workspace.id,
      workspaceIsInternal: workspace.isInternal,
      name,
      url,
      defaultCurrency,
      timezone,
      contactEmail: contactEmail || defaultContactEmail,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      project: newProject,
    }
  })
