import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { InviteMemberDialog } from "./_components/invite-member-dialog"

export default function WorkSpaceSettingsMembersLoading() {
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
      <Card className="animate-pulse bg-muted">
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <CardContent>
          You are currently on the {<Skeleton className="inline h-[15px] w-[30px]" />} plan.
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button className="text-transparent">Manage Subscription</Button>
        </CardFooter>
      </Card>
      <Card className="mt-4 animate-pulse bg-muted">
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>TODO</CardContent>
      </Card>
    </DashboardShell>
  )
}
