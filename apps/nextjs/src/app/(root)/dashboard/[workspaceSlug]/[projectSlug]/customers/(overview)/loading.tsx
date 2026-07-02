import { Button } from "@unprice/ui/button"
import { Plus } from "lucide-react"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerDialog } from "../_components/customers/customer-dialog"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"

import { SuperLink } from "~/components/super-link"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Customers"
          description="Customers are the economic actors that hold subscriptions, wallet credits, invoices, and budgeted runs."
          action={
            <CustomerDialog>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Customer
              </Button>
            </CustomerDialog>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink active asChild>
            <SuperLink href={"#"}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
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
            Customer money state
          </Typography>
        </div>
        <DataTableSkeleton
          columnCount={8}
          showDateFilterOptions={true}
          showViewOptions={true}
          searchableColumnCount={1}
          cellWidths={["10rem", "30rem", "20rem", "20rem", "20rem", "20rem", "12rem", "8rem"]}
        />
      </div>
    </DashboardShell>
  )
}
