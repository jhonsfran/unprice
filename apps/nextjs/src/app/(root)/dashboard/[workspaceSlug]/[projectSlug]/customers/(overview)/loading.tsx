import { Button } from "@unprice/ui/button"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
import { CustomerDialog } from "../_components/customers/customer-dialog"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"

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
              <Button>Create Customer</Button>
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
        <SectionIntro
          title="Customer money state"
          description="Inspect which customers can be billed, which ones are active, and where to follow subscriptions, wallets, invoices, and runs."
        />
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
