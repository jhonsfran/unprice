import { FEATURE_SLUGS } from "@unprice/config"
import { BadgeCheck, KeyRound, Link2, ShieldX } from "lucide-react"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { EvidenceMetricStrip, EvidenceMetricTile } from "~/components/analytics/evidence-panel"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import UpgradePlanError from "~/components/layout/error"
import HeaderTab from "~/components/layout/header-tab"
import { SectionIntro } from "~/components/layout/section-intro"
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
  const activeKeys = apikeys.filter(
    (apikey) =>
      apikey.revokedAt === null && (apikey.expiresAt === null || apikey.expiresAt > Date.now())
  ).length
  const revokedKeys = apikeys.filter((apikey) => apikey.revokedAt !== null).length
  const boundKeys = apikeys.filter((apikey) => Boolean(apikey.defaultCustomerId)).length

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
          <SectionIntro
            title="Request-path keys"
            description="Use project API keys to check access, record usage, consume usage, and start budgeted runs from your application."
          />
          <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
            <EvidenceMetricTile
              label="Visible keys"
              value={String(apikeys.length)}
              helper={`${pageCount} result ${pageCount === 1 ? "page" : "pages"}`}
              icon={<KeyRound className="h-4 w-4" />}
            />
            <EvidenceMetricTile
              label="Active"
              value={String(activeKeys)}
              helper="Can authenticate project requests"
              icon={<BadgeCheck className="h-4 w-4" />}
              tone={activeKeys > 0 ? "success" : "default"}
            />
            <EvidenceMetricTile
              label="Bound to customer"
              value={String(boundKeys)}
              helper="Default customer for request-path calls"
              icon={<Link2 className="h-4 w-4" />}
            />
            <EvidenceMetricTile
              label="Revoked"
              value={String(revokedKeys)}
              helper="No longer accepted"
              icon={<ShieldX className="h-4 w-4" />}
              tone={revokedKeys > 0 ? "destructive" : "default"}
            />
          </EvidenceMetricStrip>
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
