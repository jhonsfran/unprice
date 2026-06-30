import { walletCreditSourceSchema } from "@unprice/db/validators"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { api } from "~/trpc/server"
import { columns as walletCreditColumns } from "../../_components/wallet/table-wallet-credits/columns"
import { WalletBalanceSummary } from "../../_components/wallet/wallet-balance-summary"

export const dynamic = "force-dynamic"

const walletCreditStatuses = ["active", "expired"] as const

export default async function CustomerWalletPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { customerId } = params
  const { customer, wallet } = await api.customers.getWallet({
    customerId,
  })

  if (!customer) {
    notFound()
  }

  const walletCredits = wallet.credits.map((credit) => ({
    ...credit,
    currency: wallet.currency,
  }))

  return (
    <div className="mt-4 flex flex-col gap-6">
      <WalletBalanceSummary wallet={wallet} />

      <div>
        <div className="flex flex-col px-1 py-4">
          <Typography variant="p" affects="removePaddingMargin">
            Wallet credits for this customer
          </Typography>
        </div>
        <Suspense
          fallback={
            <DataTableSkeleton
              columnCount={8}
              searchableColumnCount={1}
              filterableColumnCount={2}
              cellWidths={["18rem", "10rem", "10rem", "10rem", "10rem", "10rem", "14rem", "14rem"]}
            />
          }
        >
          <DataTable
            columns={walletCreditColumns}
            data={walletCredits}
            emptyState={{
              title: "No wallet credits",
              description: "This customer has no issued, active, or expired wallet credits yet.",
            }}
            hidePaginationWhenEmpty
            filterOptions={{
              filterBy: "id",
              filterColumns: true,
              filterSelectors: {
                source: walletCreditSourceSchema.options.map((value) => ({
                  value,
                  label: value,
                })),
                status: walletCreditStatuses.map((value) => ({
                  value,
                  label: value,
                })),
              },
            }}
          />
        </Suspense>
      </div>
    </div>
  )
}
