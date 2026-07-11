import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Budgeted Runs"
          description="Budgeted run lifecycle, spend, and failure evidence across this project."
          action={
            <CodeApiSheet defaultMethod="startBudgetedRun">
              <Button variant={"link"}>
                <Code className="mr-2 h-4 w-4" />
                API
              </Button>
            </CodeApiSheet>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={"#"}>Customers</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={"#"}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={"#"}>Budgeted Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <SectionIntro
          title="Budgeted workloads across customers"
          description="Runs label workload spend, reserve budget, and stop over-budget work without making Unprice the workload owner."
        />
        <DataTableSkeleton
          columnCount={8}
          searchableColumnCount={1}
          filterableColumnCount={2}
          cellWidths={["16rem", "10rem", "20rem", "14rem", "10rem", "10rem", "12rem", "12rem"]}
        />
      </div>
    </DashboardShell>
  )
}
