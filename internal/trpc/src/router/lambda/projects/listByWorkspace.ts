import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#trpc"
import { getRandomPatternStyle } from "#utils/generate-pattern"

export const listByWorkspace = protectedWorkspaceProcedure
  .input(z.object({ workspaceSlug: z.string() }))
  .output(
    z.object({
      projects: z.array(
        projectSelectBaseSchema.extend({
          styles: z.object({
            backgroundImage: z.string(),
          }),
          workspace: workspaceSelectBase.pick({
            slug: true,
            plan: true,
          }),
        })
      ),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const { projects: projectsService } = opts.ctx.services

    const { err, val: projects } = await projectsService.listProjectsByWorkspace({
      workspaceId: workspace.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      projects: projects.map((project) => ({
        ...project,
        styles: getRandomPatternStyle(project.id),
      })),
    }
  })
