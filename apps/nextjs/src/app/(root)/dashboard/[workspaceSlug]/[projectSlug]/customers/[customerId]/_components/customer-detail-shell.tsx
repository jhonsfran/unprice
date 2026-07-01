"use client"

import { useSelectedLayoutSegments } from "next/navigation"
import type { ReactNode } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export function CustomerDetailShell({
  children,
  header,
  tabs,
}: {
  children: ReactNode
  header: ReactNode
  tabs: ReactNode
}) {
  const segments = useSelectedLayoutSegments().filter((segment) => !segment.startsWith("("))
  const isInvoiceDetail = segments[0] === "invoices" && segments.length > 1

  if (isInvoiceDetail) {
    return <DashboardShell>{children}</DashboardShell>
  }

  return (
    <DashboardShell header={header}>
      {tabs}
      {children}
    </DashboardShell>
  )
}
