import { TRPCError } from "@trpc/server"
import type { BudgetCatalogRow } from "@unprice/db/validators"
import { Typography } from "@unprice/ui/typography"
import type { ReactNode } from "react"
import { CopyButton } from "~/components/copy-button"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { formatUnit } from "../_components/budget-format"
import { BudgetLive } from "../_components/budget-live"
import { BudgetNotFound } from "../_components/budget-not-found"
import { BudgetStatusBadge } from "../_components/budget-status-badge"

export const dynamic = "force-dynamic"

export default async function BudgetPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string; budgetId: string }>
}) {
  const { workspaceSlug, projectSlug, budgetId } = await props.params
  const listHref = `/${workspaceSlug}/${projectSlug}/budgets`
  const budget = await api.budgets.get({ id: budgetId }).catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") return null
    throw error
  })

  if (!budget) {
    return (
      <DashboardShell>
        <BudgetNotFound listHref={listHref} />
      </DashboardShell>
    )
  }

  return (
    <DashboardShell header={<BudgetHeader budget={budget} />}>
      <BudgetLive id={budget.id} listHref={listHref} />
    </DashboardShell>
  )
}

function BudgetHeader({
  budget,
  action,
}: {
  budget: Pick<BudgetCatalogRow, "key" | "status" | "closesAt" | "unit" | "version">
  action?: ReactNode
}) {
  return (
    <div className="flex w-full flex-col items-start justify-between gap-4 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Typography variant="h3" className="truncate font-mono" title={budget.key}>
            {budget.key}
          </Typography>
          <CopyButton value={budget.key} />
          <BudgetStatusBadge status={budget.status} closesAt={budget.closesAt} />
        </div>
        <span className="text-muted-foreground text-sm">
          {formatUnit(budget.unit)} · v{budget.version}
        </span>
      </div>
      {action}
    </div>
  )
}
