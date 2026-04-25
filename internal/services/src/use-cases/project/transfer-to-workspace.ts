import { type Database, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import type { Project } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type TransferToWorkspaceDeps = {
  db: Database
  logger: Logger
}

type TransferToWorkspaceInput = {
  project: {
    id: string
    isMain: boolean | null
    workspaceId: string
  }
  targetWorkspaceId: string
}

export async function transferToWorkspace(
  deps: TransferToWorkspaceDeps,
  input: TransferToWorkspaceInput
): Promise<
  Result<
    | { state: "main_project_conflict" | "already_in_target" | "target_workspace_not_found" }
    | { state: "ok"; project: Project | undefined; workspaceSlug: string | undefined },
    FetchError
  >
> {
  const { project, targetWorkspaceId } = input

  deps.logger.set({
    business: {
      operation: "project.transfer_to_workspace",
      project_id: project.id,
    },
  })

  if (project.isMain) {
    return Ok({
      state: "main_project_conflict",
    })
  }

  if (project.workspaceId === targetWorkspaceId) {
    return Ok({
      state: "already_in_target",
    })
  }

  try {
    const targetWorkspace = await deps.db.query.workspaces.findFirst({
      columns: {
        id: true,
        slug: true,
      },
      where: (workspace, { eq }) => eq(workspace.id, targetWorkspaceId),
    })

    if (!targetWorkspace?.id) {
      return Ok({
        state: "target_workspace_not_found",
      })
    }

    const updatedProject = await deps.db
      .update(schema.projects)
      .set({
        workspaceId: targetWorkspace.id,
      })
      .where(eq(schema.projects.id, project.id))
      .returning()
      .then((rows) => rows[0] ?? undefined)

    return Ok({
      state: "ok",
      project: updatedProject,
      workspaceSlug: targetWorkspace.slug,
    })
  } catch (error) {
    const e = error as Error
    deps.logger.error(e, {
      context: "error transferring project to workspace",
      projectId: project.id,
      targetWorkspaceId,
    })

    return Err(
      new FetchError({
        message: `error transferring project to workspace: ${e.message}`,
        retry: false,
      })
    )
  }
}
