import { TRPCError } from "@trpc/server"
import { getSession } from "@unprice/auth/server-rsc"
import type { BudgetCatalogRow } from "@unprice/db/validators"
import { Typography } from "@unprice/ui/typography"
import type { ReactNode } from "react"
import { CopyButton } from "~/components/copy-button"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { BudgetDebugSheet } from "../_components/budget-debug-sheet"
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
  const [budget, session] = await Promise.all([
    api.budgets.get({ id: budgetId }).catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") return null
      throw error
    }),
    getSession(),
  ])
  const role = session?.user.workspaces.find((workspace) => workspace.slug === workspaceSlug)?.role

  if (!budget) {
    return (
      <DashboardShell>
        <BudgetNotFound listHref={listHref} />
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      header={
        <BudgetHeader
          budget={budget}
          action={<BudgetDebugSheet id={budget.id} budgetKey={budget.key} />}
        />
      }
    >
      <BudgetLive
        id={budget.id}
        listHref={listHref}
        canRelease={role === "OWNER" || role === "ADMIN"}
      />
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
    <div className="flex w-full flex-col items-start justify-between gap-4 sm:flex-row">
      <div className="flex w-full min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Typography variant="h3" className="min-w-0 font-mono [overflow-wrap:anywhere]">
            {budget.key}
          </Typography>
          <span className="flex items-center gap-2">
            <CopyButton value={budget.key} />
            <BudgetStatusBadge status={budget.status} closesAt={budget.closesAt} />
          </span>
        </div>
        <span className="font-mono text-muted-foreground text-xs">
          {formatUnit(budget.unit)} · v{budget.version}
        </span>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}
