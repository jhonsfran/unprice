import { TRPCError } from "@trpc/server"
import { projectSelectBaseSchema, transferToWorkspaceSchema } from "@unprice/db/validators"
import { transferToWorkspace as transferToWorkspaceUseCase } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"
import { projectWorkspaceGuard } from "#utils"

export const transferToWorkspace = protectedWorkspaceProcedure
  .input(transferToWorkspaceSchema)
  .output(
    z.object({
      project: projectSelectBaseSchema.optional(),
      workspaceSlug: z.string().optional(),
    })
  )
  .mutation(async (opts) => {
    const { targetWorkspaceId, projectSlug } = opts.input
    const _workspace = opts.ctx.workspace

    // only owner can transfer a project to a workspace
    opts.ctx.verifyRole(["OWNER"])

    const { project: projectData } = await projectWorkspaceGuard({
      projectSlug,
      ctx: opts.ctx,
    })

    const { err, val } = await transferToWorkspaceUseCase(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        project: {
          id: projectData.id,
          isMain: projectData.isMain,
          workspaceId: projectData.workspaceId,
        },
        targetWorkspaceId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "main_project_conflict") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot transfer main project",
      })
    }

    if (val.state === "already_in_target") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Project is already in the target workspace",
      })
    }

    if (val.state === "target_workspace_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "target workspace not found",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error transferring project to workspace",
      })
    }

    return {
      project: val.project,
      workspaceSlug: val.workspaceSlug,
    }
  })
