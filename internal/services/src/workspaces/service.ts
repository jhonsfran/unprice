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
import { toErrorContext } from "../utils/log-context"

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
      this.logger.error("error getting workspace by slug", {
        error: toErrorContext(err),
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
      this.logger.error("error counting workspace memberships by user", {
        error: toErrorContext(err),
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
      | { state: "user_not_found" | "member_creation_failed" }
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

        const existingWorkspace = await tx.query.workspaces.findFirst({
          where: (workspace, { eq }) => eq(workspace.unPriceCustomerId, unPriceCustomerId),
        })

        let workspaceId = ""
        let workspace: Workspace | null = null

        if (!existingWorkspace?.id) {
          const createdWorkspace = await tx
            .insert(schema.workspaces)
            .values({
              id: id ?? newId("workspace"),
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

          workspaceId = createdWorkspace.id
          workspace = createdWorkspace as Workspace
        } else {
          workspaceId = existingWorkspace.id
          workspace = existingWorkspace as Workspace
        }

        const member = await tx.query.members.findFirst({
          where: (memberRecord, { eq, and }) =>
            and(eq(memberRecord.workspaceId, workspaceId), eq(memberRecord.userId, user.id)),
        })

        if (!member) {
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
        }

        return { state: "ok", workspace: workspace! } as const
      }),
      (error) =>
        new FetchError({
          message: `error creating workspace record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error creating workspace record", {
        error: toErrorContext(err),
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
      this.logger.error("error listing workspace members", {
        error: toErrorContext(err),
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
      this.logger.error("error deactivating workspace by id", {
        error: toErrorContext(err),
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
      this.logger.error("error listing workspace invites", {
        error: toErrorContext(err),
        workspaceId,
      })
      return Err(err)
    }

    return Ok(val as WorkspaceInvite[])
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
      with: {
        members: true,
      },
      where: (workspace, operators) => operators.and(operators.eq(workspace.id, workspaceId)),
    })

    if (workspaceData && workspaceData.members.length <= 1) {
      return Ok({
        state: "only_owner_conflict",
      })
    }

    const { val, err } = await wrapResult(
      this.db
        .delete(schema.members)
        .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, user.id)))
        .returning()
        .then((members) => members[0] ?? null),
      (error) =>
        new FetchError({
          message: `error removing workspace member: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error removing workspace member", {
        error: toErrorContext(err),
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
      this.logger.error("error listing workspaces by user", {
        error: toErrorContext(err),
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
