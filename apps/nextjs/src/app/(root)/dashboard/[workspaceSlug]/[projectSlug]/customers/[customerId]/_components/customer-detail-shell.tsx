"use client"

import { useSelectedLayoutSegments } from "next/navigation"
import type { ReactNode } from "react"
import { CustomerEconomicHeader } from "./customer-economic-header"
import { CustomerTabs } from "./customer-tabs"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import type { RouterOutputs } from "@unprice/trpc/routes"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]

export function CustomerDetailShell({
  children,
  customer,
  baseUrl,
}: {
  children: ReactNode
  customer: Customer
  baseUrl: string
}) {
  const segments = useSelectedLayoutSegments().filter((segment) => !segment.startsWith("("))
  const isInvoiceDetail = segments[0] === "invoices" && segments.length > 1

  if (isInvoiceDetail) {
    return <DashboardShell>{children}</DashboardShell>
  }

  return (
    <DashboardShell header={<CustomerEconomicHeader customer={customer} />}>
      <CustomerTabs baseUrl={baseUrl} />
      {children}
    </DashboardShell>
  )
}
