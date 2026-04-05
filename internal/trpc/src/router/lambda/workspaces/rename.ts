import { TRPCError } from "@trpc/server"
import { workspaceSelectBase } from "@unprice/db/validators"
import { protectedWorkspaceProcedure } from "#trpc"

export const rename = protectedWorkspaceProcedure
  .input(workspaceSelectBase.pick({ name: true }))
  .output(workspaceSelectBase)
  .mutation(async (opts) => {
    const { name } = opts.input
    const workspace = opts.ctx.workspace
    const { workspaces } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val, err } = await workspaces.renameWorkspaceRecord({
      workspaceId: workspace.id,
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
        message: "Workspace not found",
      })
    }

    return val.workspace
  })
