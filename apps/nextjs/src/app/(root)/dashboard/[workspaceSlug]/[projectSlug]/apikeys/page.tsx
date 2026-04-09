import { FEATURE_SLUGS } from "@unprice/config"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { entitlementFlag } from "~/lib/flags"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import NewApiKeyDialog from "./_components/new-api-key-dialog"
import { columns } from "./_components/table/columns"

export const dynamic = "force-dynamic"

export default async function ApiKeysPage(props: {
  params: { projectSlug: string; workspaceSlug: string }
  searchParams: SearchParams
}) {
  const isApiKeysEnabled = await entitlementFlag(FEATURE_SLUGS.API_KEYS.SLUG)

  if (!isApiKeysEnabled) {
    return <UpgradePlanError />
  }

  const filters = dataTableParams(props.searchParams)
  const { apikeys, pageCount } = await api.apikeys.listByActiveProject(filters)

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="API Keys"
          description="All the apis of the system"
          action={<NewApiKeyDialog />}
        />
      }
    >
      <Suspense
        fallback={
          <DataTableSkeleton
            columnCount={6}
            cellWidths={["10rem", "24rem", "32rem", "12rem", "8rem"]}
            showDateFilterOptions
            showViewOptions
          />
        }
      >
        <DataTable
          pageCount={pageCount}
          columns={columns}
          data={apikeys}
          filterOptions={{
            filterBy: "name",
            filterColumns: true,
            filterDateRange: true,
            filterServerSide: false,
          }}
        />
      </Suspense>
    </DashboardShell>
  )
}
