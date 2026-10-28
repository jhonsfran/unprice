import { DOCS_DOMAIN } from "@unprice/config"
import { budgetCapSchema, budgetCatalogStatusSchema } from "@unprice/db/validators"
import { buttonVariants } from "@unprice/ui/button"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { TermList } from "~/components/budgets/budget-terms"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { OpenBudgetByKey } from "../_components/open-budget-by-key"
import { columns } from "../_components/table-budgets/columns"
import { TestBudget } from "../_components/test-budget"

export const dynamic = "force-dynamic"

export default async function ProjectBudgetsPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { workspaceSlug, projectSlug } = await props.params
  const filters = dataTableParams(await props.searchParams)
  const { budgets, pageCount } = await api.budgets.list(filters)
  const isFiltered = Boolean(filters.search) || Object.keys(filters.filters).length > 0

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Budgets"
          description="Spend caps your app enforces per customer, run, or agent. Open one for its live balance."
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
                  description:
                    "Try the hard cap now with a test budget, or create a runtime key and let your app upsert its first budget through the API.",
                  action: (
                    <div className="flex flex-col items-center gap-5">
                      <TestBudget />
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <SuperLink
                          href={`/${workspaceSlug}/onboarding/budgets?${new URLSearchParams({ project: projectSlug })}`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          Set up a runtime key
                        </SuperLink>
                        <a
                          href={`${DOCS_DOMAIN}budgets/quickstart`}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          Read the quickstart
                        </a>
                      </div>
                      <TermList
                        terms={["budget key", "runtime key", "config key"]}
                        className="max-w-md text-left"
                      />
                    </div>
                  ),
                }
          }
          hidePaginationWhenEmpty
          toolbarAction={<OpenBudgetByKey />}
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
