import { TRPCError } from "@trpc/server"

import type { ProjectExtended, User, WorkspaceRole } from "@unprice/db/validators"

import { createProjectWorkspaceGuardQuery } from "@unprice/db/queries"
import type { Context } from "#trpc"
import { db } from "./db"

interface ProjectGuardType {
  project: ProjectExtended
  member: User & { role: WorkspaceRole }
  verifyRole: (roles: WorkspaceRole[]) => void
}

export const projectWorkspaceGuard = async ({
  projectSlug,
  projectId,
  workspaceSlug,
  ctx,
}: {
  projectId?: string
  projectSlug?: string
  workspaceSlug?: string
  ctx: Context
}): Promise<ProjectGuardType> => {
  const userId = ctx.session?.user.id
  const expectedWorkspaceSlug = workspaceSlug ?? ctx.activeWorkspaceSlug

  if (!userId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No userId active in the session",
    })
  }

  if (!projectId && !projectSlug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Project ID or project slug is required",
    })
  }

  // we execute this in a prepared statement to improve performance
  // INFO: keep in mind that this executes outside of the context of trpc
  // apart from checking the project is part of the workspace, we also check if the user has access to the workspace
  const data = await createProjectWorkspaceGuardQuery(db)
    .execute({
      projectId: projectId,
      projectSlug: projectSlug,
      userId,
    })
    .then((response) => response[0] ?? null)

  const project = data?.project
  const workspace = data?.workspace
  const member = data?.member as User & { role: WorkspaceRole }

  if (!member || !project || !workspace) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Project not found or you don't have access to the project",
    })
  }

  if (!project.enabled) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Project is disabled, please contact support",
    })
  }

  if (!workspace.enabled) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Workspace is disabled, please contact support",
    })
  }

  if (expectedWorkspaceSlug !== workspace.slug) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Active workspace does not match the workspace of the project",
    })
  }

  const verifyRole = (roles: WorkspaceRole[]) => {
    if (roles && !roles.includes(member.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `You must be a member with roles (${roles.join(
          "/"
        )}) of this workspace to perform this action`,
      })
    }
  }

  // TODO: fix the query so we can we ProjectExtended without this
  return {
    project: {
      ...project,
      workspace,
    } as ProjectExtended,
    member: member,
    verifyRole,
  }
}
