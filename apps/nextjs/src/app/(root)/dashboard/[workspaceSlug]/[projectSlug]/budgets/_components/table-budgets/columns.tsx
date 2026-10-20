"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { formatDistanceToNowStrict } from "date-fns"
import { CopyButton } from "~/components/copy-button"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { formatBudgetAmount, formatUnit } from "../budget-format"
import { BudgetStatusBadge } from "../budget-status-badge"

type BudgetRow = RouterOutputs["budgets"]["list"]["budgets"][number]

function formatLimits({ limits, unit }: Pick<BudgetRow, "limits" | "unit">): string {
  if (limits.length === 0) return "uncapped"
  return limits
    .map((limit) => {
      const window = limit.window === "never" ? "" : `/${limit.window}`
      return `${formatBudgetAmount(limit.amount, unit)}${window} ${limit.enforce}`
    })
    .join(" · ")
}

export const columns: ColumnDef<BudgetRow>[] = [
  {
    accessorKey: "key",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Key" />,
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-1">
        <SuperLink
          href={`./budgets/${row.original.id}`}
          className="truncate font-mono text-sm hover:underline"
          title={row.original.key}
        >
          {row.original.key}
        </SuperLink>
        <CopyButton value={row.original.key} className="size-3.5 text-muted-foreground" />
      </div>
    ),
    size: 64,
  },
  {
    // the cap filter reads this column; its cells show each limit's enforcement
    accessorKey: "cap",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Limits" />,
    cell: ({ row }) => (
      <SuperLink
        href={`./budgets/${row.original.id}`}
        className="whitespace-nowrap font-mono text-xs tabular-nums"
      >
        {formatLimits(row.original)}
      </SuperLink>
    ),
    size: 72,
  },
  {
    accessorKey: "unit",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Unit" />,
    cell: ({ row }) => <span className="font-mono text-xs">{formatUnit(row.original.unit)}</span>,
    size: 24,
  },
  {
    accessorKey: "status",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <BudgetStatusBadge status={row.original.status} closesAt={row.original.closesAt} />
    ),
    size: 28,
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Changed" />,
    cell: ({ row }) => (
      <span
        className="whitespace-nowrap text-muted-foreground text-xs"
        title={formatDate(row.original.updatedAt, "UTC", "yyyy-MM-dd HH:mm:ss 'UTC'")}
        suppressHydrationWarning
      >
        {formatDistanceToNowStrict(row.original.updatedAt, { addSuffix: true })}
      </span>
    ),
    size: 28,
  },
]
