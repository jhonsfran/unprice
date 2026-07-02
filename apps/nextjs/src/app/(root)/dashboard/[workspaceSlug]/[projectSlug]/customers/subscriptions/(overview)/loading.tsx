import { Button } from "@unprice/ui/button"
import { Plus } from "lucide-react"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerDialog } from "../../_components/customers/customer-dialog"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"

import { SuperLink } from "~/components/super-link"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Subscriptions"
          description="Connect customers to plan versions, billing periods, wallet policy, and invoice evidence."
          action={
            <CustomerDialog>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Subscription
              </Button>
            </CustomerDialog>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={"#"}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={"#"}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={"#"}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            Subscription evidence across this project
          </Typography>
        </div>
        <DataTableSkeleton
          columnCount={12}
          searchableColumnCount={1}
          filterableColumnCount={2}
          cellWidths={[
            "10rem",
            "40rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "12rem",
            "8rem",
          ]}
        />
      </div>
    </DashboardShell>
  )
}
