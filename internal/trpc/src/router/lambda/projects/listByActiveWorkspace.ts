import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"
import { getRandomPatternStyle } from "#utils/generate-pattern"

export const listByActiveWorkspace = protectedWorkspaceProcedure
  .input(z.void())
  .output(
    z.object({
      projects: z.array(
        projectSelectBaseSchema.extend({
          styles: z.object({
            backgroundImage: z.string(),
          }),
          workspace: workspaceSelectBase.pick({
            slug: true,
          }),
        })
      ),
    })
  )
  .query(async (opts) => {
    const activeWorkspaceId = opts.ctx.workspace.id
    const { projects: projectsService } = opts.ctx.services

    const { err, val: projects } = await projectsService.listActiveWorkspaceProjects({
      workspaceId: activeWorkspaceId,
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
