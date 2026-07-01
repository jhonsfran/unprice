import { Button } from "@unprice/ui/button"
import { ChevronDown, Plus } from "lucide-react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"

import { Separator } from "@unprice/ui/separator"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { SuperLink } from "~/components/super-link"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="FREE"
          description="free plan for the project"
          label="active"
          id="1"
          action={
            <div className="button-primary flex items-center space-x-1 rounded-md">
              <div className="sm:col-span-full">
                <Button variant={"custom"}>
                  <Plus className="mr-2 h-4 w-4" />
                  Version
                </Button>
              </div>

              <Separator orientation="vertical" className="h-[20px] p-0" />
              <Button variant={"custom"}>
                <span className="sr-only">Actions</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink active asChild>
            <SuperLink href={"#"}>Versions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={"#"}>Subscriptions</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>
      <div className="mt-4">
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            Plan version subscription evidence.
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
