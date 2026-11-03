import type { WorkspaceRole } from "@unprice/db/validators"
import {
  type DeletePersonalWorkspaceInput,
  deletePersonalWorkspace,
} from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import type { Context } from "#trpc"

export type DeletePersonalMutationCtx = Pick<Context, "logger" | "services"> & {
  userId: string
  verifyRole: (roles: WorkspaceRole[]) => void
  workspace: {
    id: string
  }
}

export async function deletePersonalMutation(opts: {
  input: DeletePersonalWorkspaceInput
  ctx: DeletePersonalMutationCtx
}) {
  // only the owner can delete a personal workspace (and the account that comes with it)
  opts.ctx.verifyRole(["OWNER"])

  const result = await deletePersonalWorkspace(
    {
      services: {
        workspaces: opts.ctx.services.workspaces,
        projects: opts.ctx.services.projects,
        subscriptions: opts.ctx.services.subscriptions,
        customers: opts.ctx.services.customers,
      },
      logger: opts.ctx.logger,
    },
    {
      workspaceId: opts.ctx.workspace.id,
      userId: opts.ctx.userId,
      confirmation: opts.input.confirmation,
    }
  )

  if (result.err) {
    throw domainErrorToTrpcError(result.err, "Failed to delete personal workspace")
  }

  return result.val
}
