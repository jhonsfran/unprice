import { type Database, and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { createSlug, newId } from "@unprice/db/utils"
import type {
  Member,
  User,
  Workspace,
  WorkspaceInsert,
  invitesSelectBase,
  listMembersSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { z } from "zod"
import { canAssignWorkspaceRole } from "./roles"

type WorkspaceInvite = z.infer<typeof invitesSelectBase>
type WorkspaceMember = z.infer<typeof listMembersSchema>
type WorkspaceWithMembership = Workspace & {
  role: Member["role"]
  userId: User["id"]
}

export class WorkspaceService {
  private readonly db: Database
  private readonly logger: Logger

  constructor({
    db,
    logger,
  }: {
    db: Database
    logger: Logger
  }) {
    this.db = db
    this.logger = logger
  }

  public async getWorkspaceBySlug({
    slug,
  }: {
    slug: string
  }): Promise<Result<Workspace | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.workspaces.findFirst({
        where: (workspace, { eq }) => eq(workspace.slug, slug),
      }),
      (error) =>
        new FetchError({
          message: `error getting workspace by slug: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error getting workspace by slug",
        slug,
      })
      return Err(err)
    }

    return Ok((val as Workspace | null) ?? null)
  }

  public async countMembershipsByUser({
    userId,
  }: {
    userId: string
  }): Promise<Result<number, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.members)
        .where(eq(schema.members.userId, userId))
        .then((rows) => rows[0]?.count ?? 0),
      (error) =>
        new FetchError({
          message: `error counting workspace memberships by user: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error counting workspace memberships by user",
        userId,
      })
      return Err(err)
    }

    return Ok(Number(val))
  }

  public async createWorkspaceRecord({
    input,
    userId,
    plan,
  }: {
    input: WorkspaceInsert
    userId: string
    plan: Workspace["plan"]
  }): Promise<
    Result<
      | { state: "user_not_found" | "member_creation_failed" | "workspace_claim_conflict" }
      | { state: "ok"; workspace: Workspace },
      FetchError
    >
  > {
    const { name, unPriceCustomerId, isInternal, id, isPersonal } = input

    const user = await this.db.query.users.findFirst({
      where: (dbUser, { eq }) => eq(dbUser.id, userId),
    })

    if (!user) {
      return Ok({ state: "user_not_found" })
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const slug = createSlug()
        const workspaceId = id ?? newId("workspace")

        const existingWorkspace = await tx.query.workspaces.findFirst({
          where: (workspace, { eq }) => eq(workspace.id, workspaceId),
        })

        if (existingWorkspace?.id) {
          if (existingWorkspace.unPriceCustomerId !== unPriceCustomerId) {
            return { state: "workspace_claim_conflict" } as const
          }

          const member = await tx.query.members.findFirst({
            where: (memberRecord, { eq, and }) =>
              and(
                eq(memberRecord.workspaceId, existingWorkspace.id),
                eq(memberRecord.userId, user.id)
              ),
          })

          if (!member) {
            return { state: "workspace_claim_conflict" } as const
          }

          return { state: "ok", workspace: existingWorkspace as Workspace } as const
        }

        const existingWorkspaceForCustomer = await tx.query.workspaces.findFirst({
          columns: {
            id: true,
          },
          where: (workspace, { eq }) => eq(workspace.unPriceCustomerId, unPriceCustomerId),
        })

        if (existingWorkspaceForCustomer) {
          return { state: "workspace_claim_conflict" } as const
        }

        const createdWorkspace = await tx
          .insert(schema.workspaces)
          .values({
            id: workspaceId,
            slug,
            name,
            imageUrl: user.image,
            isPersonal: isPersonal ?? false,
            isInternal: isInternal ?? false,
            createdBy: user.id,
            unPriceCustomerId,
            plan,
          })
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!createdWorkspace?.id) {
          return { state: "member_creation_failed" } as const
        }

        const membership = await tx
          .insert(schema.members)
          .values({
            userId: user.id,
            workspaceId,
            role: "OWNER",
          })
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!membership?.userId) {
          return { state: "member_creation_failed" } as const
        }

        return { state: "ok", workspace: createdWorkspace as Workspace } as const
      }),
      (error) =>
        new FetchError({
          message: `error creating workspace record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error creating workspace record",
        userId,
        unPriceCustomerId,
      })
      return Err(err)
    }

    return Ok(val)
  }

  public async listWorkspaceMembers({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<Result<WorkspaceMember[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.members.findMany({
        with: {
          user: true,
          workspace: true,
        },
        where: (member, { eq, and }) => and(eq(member.workspaceId, workspaceId)),
        orderBy: (members) => members.createdAtM,
      }),
      (error) =>
        new FetchError({
          message: `error listing workspace members: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error listing workspace members",
        workspaceId,
      })
      return Err(err)
    }

    return Ok(val as WorkspaceMember[])
  }

  public async deactivateWorkspaceById({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<Result<Workspace | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(schema.workspaces)
        .set({
          enabled: false,
        })
        .where(eq(schema.workspaces.id, workspaceId))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error deactivating workspace by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error deactivating workspace by id",
        workspaceId,
      })
      return Err(err)
    }

    return Ok((val as Workspace | null) ?? null)
  }

  public async listWorkspaceInvites({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<Result<WorkspaceInvite[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.invites.findMany({
        where: (invite, { eq }) => eq(invite.workspaceId, workspaceId),
      }),
      (error) =>
        new FetchError({
          message: `error listing workspace invites: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error listing workspace invites",
        workspaceId,
      })
      return Err(err)
    }

    return Ok(val as WorkspaceInvite[])
  }

  public async changeInviteRole({
    workspaceId,
    email,
    role,
    actorRole,
  }: {
    workspaceId: string
    email: string
    role: Member["role"]
    actorRole: Member["role"]
  }): Promise<
    Result<
      { state: "not_found" | "owner_role_forbidden" } | { state: "ok"; invite: WorkspaceInvite },
      FetchError
    >
  > {
    if (!canAssignWorkspaceRole({ actorRole, targetRole: role })) {
      return Ok({ state: "owner_role_forbidden" })
    }

    const { val, err } = await wrapResult(
      this.db
        .update(schema.invites)
        .set({ role })
        .where(and(eq(schema.invites.workspaceId, workspaceId), eq(schema.invites.email, email)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating invite role: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating invite role",
        workspaceId,
        email,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok({
      state: "ok",
      invite: val as WorkspaceInvite,
    })
  }

  public async changeMemberRole({
    workspaceId,
    userId,
    role,
    actorRole,
  }: {
    workspaceId: string
    userId: string
    role: Member["role"]
    actorRole: Member["role"]
  }): Promise<
    Result<
      | { state: "not_found" | "last_owner" | "owner_role_forbidden" }
      | { state: "ok"; member: Member },
      FetchError
    >
  > {
    if (!canAssignWorkspaceRole({ actorRole, targetRole: role })) {
      return Ok({ state: "owner_role_forbidden" })
    }

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`workspace-members:${workspaceId}`}))`
        )

        const currentMember = await tx.query.members.findFirst({
          where: (member, { and, eq }) =>
            and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)),
        })

        if (!currentMember) {
          return { state: "not_found" } as const
        }

        if (currentMember.role === "OWNER" && role !== "OWNER") {
          const owners = await tx.query.members.findMany({
            columns: {
              userId: true,
            },
            where: (member, { and, eq }) =>
              and(eq(member.workspaceId, workspaceId), eq(member.role, "OWNER")),
          })

          if (owners.length <= 1) {
            return { state: "last_owner" } as const
          }
        }

        const member = await tx
          .update(schema.members)
          .set({ role })
          .where(
            and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, userId))
          )
          .returning()
          .then((rows) => rows[0] ?? null)

        if (!member) {
          return { state: "not_found" } as const
        }

        return {
          state: "ok",
          member: member as Member,
        } as const
      }),
      (error) =>
        new FetchError({
          message: `error updating member role: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating member role",
        workspaceId,
        userId,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok(val)
  }

  public async deleteInvite({
    workspaceId,
    email,
  }: {
    workspaceId: string
    email: string
  }): Promise<
    Result<{ state: "not_found" } | { state: "ok"; invite: WorkspaceInvite }, FetchError>
  > {
    const { val, err } = await wrapResult(
      this.db
        .delete(schema.invites)
        .where(and(eq(schema.invites.email, email), eq(schema.invites.workspaceId, workspaceId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error deleting invite: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error deleting invite",
        workspaceId,
        email,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok({
      state: "ok",
      invite: val as WorkspaceInvite,
    })
  }

  public async renameWorkspaceRecord({
    workspaceId,
    name,
  }: {
    workspaceId: string
    name: Workspace["name"]
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; workspace: Workspace }, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .update(schema.workspaces)
        .set({ name })
        .where(eq(schema.workspaces.id, workspaceId))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error renaming workspace: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error renaming workspace",
        workspaceId,
      })
      return Err(err)
    }

    if (!val) {
      return Ok({
        state: "not_found",
      })
    }

    return Ok({
      state: "ok",
      workspace: val as Workspace,
    })
  }

  public async removeWorkspaceMember({
    workspaceId,
    userId,
  }: {
    workspaceId: string
    userId: string
  }): Promise<
    Result<
      { state: "user_not_found" | "only_owner_conflict" } | { state: "ok"; member: Member },
      FetchError
    >
  > {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    })

    if (!user?.id) {
      return Ok({
        state: "user_not_found",
      })
    }

    const workspaceData = await this.db.query.workspaces.findFirst({
      where: (workspace, operators) => operators.and(operators.eq(workspace.id, workspaceId)),
    })

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`workspace-members:${workspaceId}`}))`
        )

        const member = await tx.query.members.findFirst({
          where: (memberRecord, { and, eq }) =>
            and(eq(memberRecord.workspaceId, workspaceId), eq(memberRecord.userId, user.id)),
        })

        if (!member) {
          return null
        }

        if (workspaceData && member.role === "OWNER") {
          const owners = await tx.query.members.findMany({
            columns: {
              userId: true,
            },
            where: (memberRecord, { and, eq }) =>
              and(eq(memberRecord.workspaceId, workspaceId), eq(memberRecord.role, "OWNER")),
          })

          if (owners.length <= 1) {
            return { state: "only_owner_conflict" } as const
          }
        }

        return tx
          .delete(schema.members)
          .where(
            and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, user.id))
          )
          .returning()
          .then((members) => members[0] ?? null)
      }),
      (error) =>
        new FetchError({
          message: `error removing workspace member: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error removing workspace member",
        workspaceId,
        userId,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "error deleting member",
          retry: false,
        })
      )
    }

    if ("state" in val && val.state === "only_owner_conflict") {
      return Ok(val)
    }

    return Ok({
      state: "ok",
      member: val as Member,
    })
  }

  public async listWorkspacesByUser({
    userId,
  }: {
    userId: string
  }): Promise<Result<WorkspaceWithMembership[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.members.findMany({
        with: {
          workspace: true,
        },
        where: (member, operators) => operators.eq(member.userId, userId),
        orderBy: (member) => member.createdAtM,
      }),
      (error) =>
        new FetchError({
          message: `error listing workspaces by user: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error listing workspaces by user",
        userId,
      })
      return Err(err)
    }

    const workspaces = val
      .map((member) => ({
        ...member.workspace,
        role: member.role,
        userId: member.userId,
      }))
      .filter((workspace) => workspace.enabled)

    return Ok(workspaces as WorkspaceWithMembership[])
  }
}
