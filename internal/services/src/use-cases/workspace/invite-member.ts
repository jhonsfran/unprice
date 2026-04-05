import type { Database } from "@unprice/db"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { Member, invitesSelectBase } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { z } from "zod"
import type { Cache } from "../../cache/service"
import { toErrorContext } from "../../utils/log-context"

type WorkspaceInvite = z.infer<typeof invitesSelectBase>

type InviteMemberDeps = {
  db: Database
  cache: Cache
  logger: Logger
  // biome-ignore lint/suspicious/noExplicitAny: platform promise scheduler
  waitUntil: (promise: Promise<any>) => void
}

type InviteMemberInput = {
  email: string
  role: Member["role"]
  name?: string | null
  userId: string
  workspace: {
    id: string
    slug: string
    name: string
    isPersonal: boolean
  }
}

export async function inviteMember(
  deps: InviteMemberDeps,
  input: InviteMemberInput
): Promise<
  Result<
    | { state: "personal_workspace_conflict" | "already_member" | "inviter_not_found" }
    | { state: "member_added" }
    | {
        state: "invite_created"
        invite: WorkspaceInvite | undefined
        inviterName: string
        inviteeName?: string | null
      },
    FetchError
  >
> {
  const { email, role, name, userId, workspace } = input

  deps.logger.set({
    business: {
      operation: "workspace.invite_member",
      workspace_id: workspace.id,
      user_id: userId,
    },
  })

  if (workspace.isPersonal) {
    return Ok({
      state: "personal_workspace_conflict",
    })
  }

  try {
    const userByEmail = await deps.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    })

    if (userByEmail) {
      const member = await deps.db.query.members.findFirst({
        where: and(
          eq(schema.members.userId, userByEmail.id),
          eq(schema.members.workspaceId, workspace.id)
        ),
      })

      if (member) {
        return Ok({
          state: "already_member",
        })
      }

      await deps.db
        .insert(schema.members)
        .values({
          userId: userByEmail.id,
          workspaceId: workspace.id,
          role,
        })
        .returning()

      deps.waitUntil(
        Promise.all([
          deps.cache.workspaceGuard.remove(`workspace-guard:${workspace.id}:${userByEmail.id}`),
          deps.cache.workspaceGuard.remove(`workspace-guard:${workspace.slug}:${userByEmail.id}`),
        ])
      )

      return Ok({
        state: "member_added",
      })
    }

    const user = await deps.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    })

    if (!user) {
      return Ok({
        state: "inviter_not_found",
      })
    }

    const invited = await deps.db
      .insert(schema.invites)
      .values({
        email,
        workspaceId: workspace.id,
        role,
        name: name ?? email,
        invitedBy: userId,
      })
      .returning()
      .then((rows) => rows[0])

    return Ok({
      state: "invite_created",
      invite: invited,
      inviterName: user.name ?? user.email,
      inviteeName: name,
    })
  } catch (error) {
    const e = error as Error
    deps.logger.error("error inviting workspace member", {
      error: toErrorContext(e),
      workspaceId: workspace.id,
      userId,
      email,
    })

    return Err(
      new FetchError({
        message: `error inviting workspace member: ${e.message}`,
        retry: false,
      })
    )
  }
}
