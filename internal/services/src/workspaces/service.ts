import type { Database } from "@unprice/db"
import type {
  Member,
  User,
  Workspace,
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
