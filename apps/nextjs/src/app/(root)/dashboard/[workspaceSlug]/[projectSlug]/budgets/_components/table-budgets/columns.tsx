"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { formatDistanceToNowStrict } from "date-fns"
import { CopyButton } from "~/components/copy-button"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatDate } from "~/lib/dates"

type BudgetRow = RouterOutputs["budgets"]["list"]["budgets"][number]

/** Money `2000.5` reads `2,000.50`, units `2000` read `2,000`; every stored decimal is kept. */
function formatLimitAmount(amount: string, money: boolean): string {
  const [whole = "0", fraction = ""] = amount.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const decimals = money ? fraction.padEnd(2, "0") : fraction
  return decimals ? `${grouped}.${decimals}` : grouped
}

function formatLimits({ limits, unit }: Pick<BudgetRow, "limits" | "unit">): string {
  if (limits.length === 0) return "uncapped"
  const money = unit.startsWith("money:")
  return limits
    .map((limit) => {
      const window = limit.window === "never" ? "" : `/${limit.window}`
      return `${formatLimitAmount(limit.amount, money)}${window} ${limit.enforce}`
    })
    .join(" · ")
}

function formatUnit(unit: string): string {
  return unit.startsWith("money:") ? unit.slice("money:".length) : unit
}

function StatusBadge({ status, closesAt }: Pick<BudgetRow, "status" | "closesAt">) {
  if (status === "closing" && closesAt !== null) {
    return (
      <Badge variant="warning" title={formatDate(closesAt, "UTC", "yyyy-MM-dd HH:mm:ss 'UTC'")}>
        <span suppressHydrationWarning>
          closes {formatDistanceToNowStrict(closesAt, { addSuffix: true })}
        </span>
      </Badge>
    )
  }
  return <Badge variant={status === "open" ? "success" : "secondary"}>{status}</Badge>
}

export const columns: ColumnDef<BudgetRow>[] = [
  {
    accessorKey: "key",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Key" />,
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-sm" title={row.original.key}>
          {row.original.key}
        </span>
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
      <span className="whitespace-nowrap font-mono text-xs tabular-nums">
        {formatLimits(row.original)}
      </span>
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
      <StatusBadge status={row.original.status} closesAt={row.original.closesAt} />
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
