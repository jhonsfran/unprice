import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, transferToPersonalProjectSchema } from "@unprice/db/validators"
import { transferToPersonal as transferToPersonalUseCase } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"
import { projectWorkspaceGuard } from "#utils"

export const transferToPersonal = protectedWorkspaceProcedure
  .input(transferToPersonalProjectSchema)
  .output(
    z.object({
      project: projectSelectBaseSchema.optional(),
      workspaceSlug: z.string().optional(),
    })
  )
  .mutation(async (opts) => {
    const { slug: projectSlug } = opts.input
    const userId = opts.ctx.userId
    const _workspace = opts.ctx.workspace

    // only owner can transfer a project to personal
    opts.ctx.verifyRole(["OWNER"])

    // get the project data
    const { project: projectData } = await projectWorkspaceGuard({
      projectSlug,
      ctx: opts.ctx,
    })

    const { err, val } = await transferToPersonalUseCase(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        userId,
        project: {
          id: projectData.id,
          isMain: projectData.isMain,
          workspace: {
            isPersonal: projectData.workspace.isPersonal,
          },
        },
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "already_in_personal_workspace") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Project is already in the personal workspace",
      })
    }

    if (val.state === "main_project_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot transfer main project",
      })
    }

    if (val.state === "personal_workspace_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "There is no personal workspace for the user",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error transferring project to personal workspace",
      })
    }

    return {
      project: val.project,
      workspaceSlug: val.workspaceSlug,
    }
  })
