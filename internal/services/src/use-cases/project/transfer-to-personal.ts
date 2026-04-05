import { type Database, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { Project } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type TransferToPersonalDeps = {
  db: Database
  logger: Logger
}

type TransferToPersonalInput = {
  userId: string
  project: {
    id: string
    isMain: boolean | null
    workspace: {
      isPersonal: boolean
    }
  }
}

export async function transferToPersonal(
  deps: TransferToPersonalDeps,
  input: TransferToPersonalInput
): Promise<
  Result<
    | {
        state:
          | "already_in_personal_workspace"
          | "main_project_conflict"
          | "personal_workspace_not_found"
      }
    | {
        state: "ok"
        project: Project | undefined
        workspaceSlug: string | undefined
      },
    FetchError
  >
> {
  const { userId, project } = input

  if (project.workspace.isPersonal) {
    return Ok({
      state: "already_in_personal_workspace",
    })
  }

  if (project.isMain) {
    return Ok({
      state: "main_project_conflict",
    })
  }

  try {
    const personalTargetWorkspace = await deps.db.query.workspaces.findFirst({
      columns: {
        id: true,
        slug: true,
      },
      where: (workspace, { eq, and }) =>
        and(eq(workspace.createdBy, userId), eq(workspace.isPersonal, true)),
    })

    if (!personalTargetWorkspace?.id) {
      return Ok({
        state: "personal_workspace_not_found",
      })
    }

    const updatedProject = await deps.db
      .update(schema.projects)
      .set({
        workspaceId: personalTargetWorkspace.id,
      })
      .where(eq(schema.projects.id, project.id))
      .returning()
      .then((rows) => rows[0] ?? undefined)

    return Ok({
      state: "ok",
      project: updatedProject,
      workspaceSlug: personalTargetWorkspace.slug,
    })
  } catch (error) {
    const e = error as Error
    deps.logger.error("error transferring project to personal workspace", {
      error: e.message,
      projectId: project.id,
      userId,
    })

    return Err(
      new FetchError({
        message: `error transferring project to personal workspace: ${e.message}`,
        retry: false,
      })
    )
  }
}
