import { notFound } from "next/navigation"
import type React from "react"
import { api } from "~/trpc/server"
import { CustomerDetailShell } from "./_components/customer-detail-shell"

export default async function CustomerDetailLayout(props: {
  children: React.ReactNode
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }>
}) {
  const { children } = props
  const { workspaceSlug, projectSlug, customerId } = await props.params
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
