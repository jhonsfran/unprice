import {
  customerLedgerAccountSchema,
  customerLedgerActivitySchema,
} from "@unprice/services/use-cases"
import { Button } from "@unprice/ui/button"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { dataTableParams } from "~/lib/searchParams"
import { api } from "~/trpc/server"
import { columns as ledgerColumns } from "../../_components/ledger/table-ledger/columns"
import { accountLabel, activityLabel } from "../../_components/ledger/table-ledger/labels"

export const dynamic = "force-dynamic"

export default async function CustomerLedgerPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>
  searchParams: Promise<SearchParams>
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const { customerId } = params
  const filters = dataTableParams(searchParams)

  const { customer, currency, movements, pageCount } = await api.customers.getLedger({
    customerId,
    ...filters,
  })

  if (!customer) {
    notFound()
  }

  // currency is stated once for the whole statement, not per row
  const ledgerMovements = movements.map((movement) => ({ ...movement, currency }))

  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Every movement in and out of this customer's balance, newest first. Amounts are signed
        against spendable balance — a hold leaves it, a release returns it — and settling a hold
        shows unsigned because that money already left. All amounts in {currency}, times in UTC.
      </p>
      <Suspense
        fallback={
          <DataTableSkeleton
            columnCount={5}
            searchableColumnCount={1}
            filterableColumnCount={2}
            cellWidths={["12rem", "16rem", "16rem", "8rem", "10rem"]}
          />
        }
      >
        <DataTable
          pageCount={pageCount}
          columns={ledgerColumns}
          data={ledgerMovements}
          // the raw transfer id is support-only; reachable from the View menu
          initialColumnVisibility={{ id: false }}
          emptyState={{
            title: "No movements yet",
            description:
              "Movements appear once this customer is granted credit, tops up, holds budget for a run, or settles usage.",
            action: (
              <CodeApiSheet defaultMethod="getWalletBalance" exampleParams={{ customerId }}>
                <Button size="sm" variant="outline">
                  <Code data-icon="inline-start" />
                  Check wallet balance
                </Button>
              </CodeApiSheet>
            ),
          }}
          hidePaginationWhenEmpty
          filterOptions={{
            filterBy: "id",
            filterPlaceholder: "Filter by run, reservation, or transfer",
            filterColumns: true,
            filterDateRange: true,
            filterServerSide: true,
            filterSelectors: {
              activity: customerLedgerActivitySchema.options.map((value) => ({
                value,
                label: activityLabel(value, "in"),
              })),
              account: customerLedgerAccountSchema.options.map((value) => ({
                value,
                label: accountLabel(value),
              })),
            },
          }}
        />
      </Suspense>
    </div>
  )
}
