import { notFound } from "next/navigation"
import type React from "react"
import { api } from "~/trpc/server"
import { CustomerDetailShell } from "./_components/customer-detail-shell"

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
    <CustomerDetailShell customer={customer} baseUrl={baseUrl}>
      {children}
    </CustomerDetailShell>
  )
}
