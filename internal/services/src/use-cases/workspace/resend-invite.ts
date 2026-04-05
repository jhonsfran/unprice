import { type Database, and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type ResendInviteDeps = {
  db: Database
  logger: Logger
}

type ResendInviteInput = {
  email: string
  workspace: {
    id: string
    name: string
    isPersonal: boolean
  }
}

export async function resendInvite(
  deps: ResendInviteDeps,
  input: ResendInviteInput
): Promise<
  Result<
    | { state: "personal_workspace_conflict" | "invite_not_found" }
    | { state: "ok"; inviterName: string; inviteeName: string | null },
    FetchError
  >
> {
  const { email, workspace } = input

  if (workspace.isPersonal) {
    return Ok({
      state: "personal_workspace_conflict",
    })
  }

  try {
    const invite = await deps.db.query.invites.findFirst({
      where: and(eq(schema.invites.email, email), eq(schema.invites.workspaceId, workspace.id)),
      with: {
        invitedBy: true,
      },
    })

    if (!invite) {
      return Ok({
        state: "invite_not_found",
      })
    }

    return Ok({
      state: "ok",
      inviterName: invite.invitedBy.name ?? invite.invitedBy.email,
      inviteeName: invite.name,
    })
  } catch (error) {
    const e = error as Error
    deps.logger.error("error resending workspace invite", {
      error: e.message,
      workspaceId: workspace.id,
      email,
    })

    return Err(
      new FetchError({
        message: `error resending workspace invite: ${e.message}`,
        retry: false,
      })
    )
  }
}
