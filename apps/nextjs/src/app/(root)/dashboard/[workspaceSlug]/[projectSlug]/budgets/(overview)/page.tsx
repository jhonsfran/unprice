import { DOCS_DOMAIN } from "@unprice/config"
import { budgetCapSchema, budgetCatalogStatusSchema } from "@unprice/db/validators"
import { buttonVariants } from "@unprice/ui/button"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { OpenBudgetByKey } from "../_components/open-budget-by-key"
import { columns } from "../_components/table-budgets/columns"

export const dynamic = "force-dynamic"

export default async function ProjectBudgetsPage(props: { searchParams: Promise<SearchParams> }) {
  const filters = dataTableParams(await props.searchParams)
  const { budgets, pageCount } = await api.budgets.list(filters)
  const isFiltered = Boolean(filters.search) || Object.keys(filters.filters).length > 0

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Budgets"
          description="Spend caps your app enforces per customer, run, or agent. Configuration as of each budget's last change."
          action={<OpenBudgetByKey />}
        />
      }
    >
      <Suspense
        fallback={
          <DataTableSkeleton
            columnCount={5}
            searchableColumnCount={1}
            filterableColumnCount={2}
            cellWidths={["16rem", "20rem", "6rem", "8rem", "8rem"]}
          />
        }
      >
        <DataTable
          pageCount={pageCount}
          columns={columns}
          data={budgets}
          emptyState={
            isFiltered
              ? undefined
              : {
                  title: "No budgets yet",
                  description: "A budget appears here after your app upserts it through the API.",
                  action: (
                    <a
                      href={`${DOCS_DOMAIN}budgets/quickstart`}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Read the quickstart
                    </a>
                  ),
                }
          }
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "key",
            filterPlaceholder: "Filter by key prefix…",
            filterServerSide: true,
            filterSelectors: {
              status: budgetCatalogStatusSchema.options.map((value) => ({ value, label: value })),
              cap: budgetCapSchema.options.map((value) => ({ value, label: value })),
            },
          }}
        />
      </Suspense>
    </DashboardShell>
  )
}
