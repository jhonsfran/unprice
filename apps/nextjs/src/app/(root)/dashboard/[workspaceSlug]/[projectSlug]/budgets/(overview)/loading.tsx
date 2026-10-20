import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Budgets"
          description="Spend caps your app enforces per customer, run, or agent. Open one for its live balance."
        />
      }
    >
      <DataTableSkeleton
        columnCount={5}
        searchableColumnCount={1}
        filterableColumnCount={2}
        cellWidths={["16rem", "20rem", "6rem", "8rem", "8rem"]}
      />
    </DashboardShell>
  )
}
