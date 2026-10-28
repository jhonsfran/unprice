import { workspaceSelectBase } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { DomainError, type DomainErrorKind } from "../../domain-error-kind"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"
import type { PersonalWorkspaceDeletionState } from "../../workspaces/service"
import { signOutCustomer } from "../customer/sign-out"

export const deletePersonalWorkspaceInputSchema = z.object({
  workspaceSlug: z.string().min(1),
  // The caller types the workspace slug to confirm; checked again here, not only in the UI.
  confirmation: z.string().trim().min(1),
})

export const deletePersonalWorkspaceOutputSchema = z.object({
  workspace: workspaceSelectBase.pick({ id: true, slug: true, name: true }),
})

const deletePersonalWorkspaceErrorCodeSchema = z.enum([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_PERSONAL",
  "WORKSPACE_IS_MAIN",
  "WORKSPACE_IS_INTERNAL",
  "WORKSPACE_NOT_OWNER",
  "WORKSPACE_HAS_OTHER_WORKSPACES",
  "WORKSPACE_CONFIRMATION_MISMATCH",
  "WORKSPACE_BILLING_PROJECT_NOT_FOUND",
])

type DeletePersonalWorkspaceErrorCode = z.infer<typeof deletePersonalWorkspaceErrorCodeSchema>

const deletePersonalWorkspaceErrorKinds: Record<DeletePersonalWorkspaceErrorCode, DomainErrorKind> =
  {
    WORKSPACE_NOT_FOUND: "not_found",
    WORKSPACE_NOT_PERSONAL: "bad_request",
    WORKSPACE_IS_MAIN: "bad_request",
    WORKSPACE_IS_INTERNAL: "bad_request",
    WORKSPACE_NOT_OWNER: "forbidden",
    WORKSPACE_HAS_OTHER_WORKSPACES: "precondition",
    WORKSPACE_CONFIRMATION_MISMATCH: "bad_request",
    WORKSPACE_BILLING_PROJECT_NOT_FOUND: "internal",
  }

const blockedStateToError: Record<
  PersonalWorkspaceDeletionState,
  { code: DeletePersonalWorkspaceErrorCode; message: string }
> = {
  not_found: { code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" },
  not_personal: {
    code: "WORKSPACE_NOT_PERSONAL",
    message: "Only personal workspaces can be deleted with this action",
  },
  main_workspace: { code: "WORKSPACE_IS_MAIN", message: "Cannot delete the main workspace" },
  internal_workspace: {
    code: "WORKSPACE_IS_INTERNAL",
    message: "Cannot delete an internal workspace",
  },
  not_owner: {
    code: "WORKSPACE_NOT_OWNER",
    message: "Only the owner of a personal workspace can delete it",
  },
  has_other_workspaces: {
    code: "WORKSPACE_HAS_OTHER_WORKSPACES",
    message:
      "Your account still belongs to other workspaces. Leave or delete them before deleting your personal workspace.",
  },
}

export class DeletePersonalWorkspaceError extends DomainError<{
  workspaceId?: string
  userId?: string
}> {
  public readonly code: DeletePersonalWorkspaceErrorCode
  public readonly kind: DomainErrorKind
  public readonly retry = false
  public override readonly name = "DeletePersonalWorkspaceError"

  constructor(opts: {
    code: DeletePersonalWorkspaceErrorCode
    message: string
    context?: { workspaceId?: string; userId?: string }
  }) {
    super({ message: opts.message, context: opts.context ?? {} })
    this.code = opts.code
    this.kind = deletePersonalWorkspaceErrorKinds[opts.code]
  }
}

export type DeletePersonalWorkspaceInput = z.infer<typeof deletePersonalWorkspaceInputSchema>
export type DeletePersonalWorkspaceOutput = z.infer<typeof deletePersonalWorkspaceOutputSchema>

export type DeletePersonalWorkspaceDeps = {
  services: Pick<ServiceContext, "workspaces" | "projects" | "subscriptions" | "customers">
  logger: Logger
  now?: () => number
}

/**
 * Deletes a personal workspace together with the account that owns it.
 *
 * 1. Check every guard (personal, not main/internal, caller is the OWNER who created it, the
 *    account holds no other workspace, the typed confirmation matches the slug).
 * 2. End the workspace's own Unprice billing: cancel its subscriptions in the main project and
 *    deactivate that billing customer. The billing records stay in the main project for audit.
 * 3. Hard-delete the workspace (cascading to its projects and all project-owned data) and the
 *    user (cascading to OAuth accounts, sessions, and memberships) in one transaction, so the
 *    next sign-in with the same identity is a first-time signup with onboarding.
 */
export async function deletePersonalWorkspace(
  deps: DeletePersonalWorkspaceDeps,
  input: {
    workspaceId: string
    userId: string
    confirmation: string
  }
): Promise<
  Result<
    DeletePersonalWorkspaceOutput,
    DeletePersonalWorkspaceError | FetchError | UnPriceSubscriptionError
  >
> {
  const { workspaces, projects } = deps.services
  const { workspaceId, userId } = input
  const context = { workspaceId, userId }

  deps.logger.set({
    business: {
      operation: "workspace.delete_personal",
      workspace_id: workspaceId,
      user_id: userId,
    },
  })

  const { err: checkErr, val: check } = await workspaces.checkPersonalWorkspaceDeletion({
    workspaceId,
    userId,
  })

  if (checkErr) {
    return Err(checkErr)
  }

  if (check.state !== "ok") {
    return Err(new DeletePersonalWorkspaceError({ ...blockedStateToError[check.state], context }))
  }

  if (input.confirmation.trim() !== check.workspace.slug) {
    return Err(
      new DeletePersonalWorkspaceError({
        code: "WORKSPACE_CONFIRMATION_MISMATCH",
        message: "Type the workspace slug exactly to confirm the deletion",
        context,
      })
    )
  }

  const { err: mainProjectErr, val: mainProject } = await projects.getMainProject()

  if (mainProjectErr) {
    return Err(mainProjectErr)
  }

  if (!mainProject?.id) {
    deps.logger.error("deletePersonalWorkspace: main project not found", context)
    return Err(
      new DeletePersonalWorkspaceError({
        code: "WORKSPACE_BILLING_PROJECT_NOT_FOUND",
        message: "Main project not found",
        context,
      })
    )
  }

  // Billing first: if cancellation fails nothing has been deleted yet and the user can retry.
  const { err: signOutErr } = await signOutCustomer(
    { services: deps.services, logger: deps.logger },
    {
      customerId: check.workspace.unPriceCustomerId,
      projectId: mainProject.id,
      now: deps.now?.() ?? Date.now(),
    }
  )

  if (signOutErr) {
    deps.logger.error(signOutErr, { ...context, context: "deletePersonalWorkspace sign out customer" })
    return Err(signOutErr)
  }

  const { err: deleteErr, val: deleted } = await workspaces.deletePersonalWorkspaceAndOwner({
    workspaceId,
    userId,
  })

  if (deleteErr) {
    return Err(deleteErr)
  }

  if (deleted.state !== "ok") {
    return Err(new DeletePersonalWorkspaceError({ ...blockedStateToError[deleted.state], context }))
  }

  return Ok({
    workspace: {
      id: deleted.workspace.id,
      slug: deleted.workspace.slug,
      name: deleted.workspace.name,
    },
  })
}
