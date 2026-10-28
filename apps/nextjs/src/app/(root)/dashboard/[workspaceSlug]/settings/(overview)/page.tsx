import { notFound } from "next/navigation"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { DeletePersonalWorkspace } from "./_components/delete-personal-workspace"
import { DeleteWorkspace } from "./_components/delete-workspace"
import { WorkspaceName } from "./_components/workspace-name"

export default async function WorkspaceSettingsPage(props: {
  params: Promise<{ workspaceSlug: string }>
}) {
  const { workspaceSlug } = await props.params
  const { workspace } = await api.workspaces.getBySlug({
    slug: workspaceSlug,
  })

  if (!workspace) {
    return notFound()
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="General Settings"
          description="Configure workspace identity and lifecycle controls."
        />
      }
    >
      <WorkspaceName workspace={workspace} />

      {workspace.isPersonal && !workspace.isMain ? (
        <DeletePersonalWorkspace workspace={workspace} />
      ) : (
        <DeleteWorkspace workspace={workspace} />
      )}
    </DashboardShell>
  )
}
