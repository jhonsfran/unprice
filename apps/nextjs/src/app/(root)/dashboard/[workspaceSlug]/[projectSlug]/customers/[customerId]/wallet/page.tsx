import { walletCreditSourceSchema } from "@unprice/db/validators"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { columns as walletCreditColumns } from "../../_components/wallet/table-wallet-credits/columns"
import { WalletBalanceSummary } from "../../_components/wallet/wallet-balance-summary"

export const dynamic = "force-dynamic"

export default async function CustomerWalletPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`
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
  const walletCreditStatuses = ["active", "expired"] as const

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={customer.email}
          description={customer.description}
          label={customer.active ? "active" : "inactive"}
          id={customer.id}
          action={<CustomerActions customer={customer} />}
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Overview</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/wallet`}>Wallet</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/runs`}>Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>

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
                columnCount={7}
                searchableColumnCount={1}
                filterableColumnCount={2}
                cellWidths={["18rem", "10rem", "10rem", "10rem", "10rem", "14rem", "14rem"]}
              />
            }
          >
            <DataTable
              columns={walletCreditColumns}
              data={walletCredits}
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
    </DashboardShell>
  )
}
