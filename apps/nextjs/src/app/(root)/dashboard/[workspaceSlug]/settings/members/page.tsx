import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"

import { DataTable } from "~/components/data-table/data-table"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { InviteMemberDialog } from "./_components/invite-member-dialog"
import { columns as columnsInvites } from "./_components/table-invites/columns"
import { columns as columnsMembers } from "./_components/table-members/columns"

export default async function WorkspaceMembersPage() {
  const [members, invites] = await Promise.all([
    api.workspaces.listMembersByActiveWorkspace(),
    api.workspaces.listInvitesByActiveWorkspace(),
  ])

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Members Settings"
          description="Invite and review team members who can operate this workspace."
          action={<InviteMemberDialog />}
        />
      }
    >
      <Tabs defaultValue="members" className="space-y-4">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invites">Invites</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="space-y-4">
          <DataTable
            className="mt-10"
            columns={columnsMembers}
            data={members.members}
            filterOptions={{
              filterBy: "name",
              filterColumns: true,
              filterDateRange: true,
            }}
          />
        </TabsContent>

        <TabsContent value="invites" className="space-y-4">
          <DataTable
            className="mt-10"
            columns={columnsInvites}
            data={invites.invites}
            filterOptions={{
              filterBy: "email",
              filterColumns: true,
              filterDateRange: true,
            }}
          />
        </TabsContent>
      </Tabs>
    </DashboardShell>
  )
}
