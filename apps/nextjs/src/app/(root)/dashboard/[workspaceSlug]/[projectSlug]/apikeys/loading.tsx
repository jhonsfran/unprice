import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import NewApiKeyDialog from "./_components/new-api-key-dialog"

export default function Loading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="API Keys"
          description="Manage project API keys and default customer access."
          action={<NewApiKeyDialog />}
        />
      }
    >
      <DataTableSkeleton
        columnCount={5}
        cellWidths={["10rem", "40rem", "12rem", "8rem"]}
        showDateFilterOptions
        showViewOptions
      />
    </DashboardShell>
  )
}
