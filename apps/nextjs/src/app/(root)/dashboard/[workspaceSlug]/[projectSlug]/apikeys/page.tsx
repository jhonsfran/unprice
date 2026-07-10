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
    return (
      <UpgradePlanError
        workspaceSlug={props.params.workspaceSlug}
        blockedFeatureSlug={FEATURE_SLUGS.API_KEYS.SLUG}
        returnTo={`/${props.params.workspaceSlug}/${props.params.projectSlug}/apikeys`}
      />
    )
  }

  const filters = dataTableParams(props.searchParams)
  const { workspaceSlug, projectSlug } = props.params
  const { apikeys, pageCount } = await api.apikeys.listByActiveProject({
    ...filters,
    workspaceSlug,
    projectSlug,
  })

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="API Keys"
          description="Create project API keys and bind a default customer for request-path calls."
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
        <div className="flex flex-col gap-4">
          <DataTable
            pageCount={pageCount}
            columns={columns}
            data={apikeys}
            emptyState={{
              title: "No API keys",
              description:
                "Create an API key before your application checks access, records usage, consumes usage, or starts budgeted runs.",
              action: <NewApiKeyDialog />,
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "name",
              filterColumns: true,
              filterDateRange: true,
              filterServerSide: false,
            }}
          />
        </div>
      </Suspense>
    </DashboardShell>
  )
}
