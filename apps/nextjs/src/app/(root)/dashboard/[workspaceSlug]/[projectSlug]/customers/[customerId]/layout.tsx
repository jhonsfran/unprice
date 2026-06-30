import { notFound } from "next/navigation"
import type React from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { CustomerEconomicHeader } from "./_components/customer-economic-header"
import { CustomerTabs } from "./_components/customer-tabs"

export default async function CustomerDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const { customer } = await api.customers.getSubscriptions({ customerId })

  if (!customer) {
    notFound()
  }

  return (
    <DashboardShell header={<CustomerEconomicHeader customer={customer} />}>
      <CustomerTabs baseUrl={baseUrl} />
      {children}
    </DashboardShell>
  )
}
