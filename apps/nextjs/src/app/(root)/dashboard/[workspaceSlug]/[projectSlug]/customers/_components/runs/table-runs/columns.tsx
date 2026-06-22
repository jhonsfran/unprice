"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatDate } from "~/lib/dates"
import { formatRunMoney } from "../format-run-money"

type CustomerRun = RouterOutputs["customers"]["getRuns"]["runs"][number]

function statusVariant(status: CustomerRun["status"]) {
  switch (status) {
    case "completed":
      return "success"
    case "failed":
    case "budget_exceeded":
      return "destructive"
    case "running":
      return "secondary"
    default:
      return "default"
  }
}

function formatRunDate(date: CustomerRun["startedAt"] | CustomerRun["endedAt"]): string {
  if (!date) {
    return "-"
  }

  return `${formatDate(new Date(date).getTime(), "UTC", "yyyy-MM-dd HH:mm:ss")} UTC`
}

export const columns: ColumnDef<CustomerRun>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Run" className="pl-4" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap pl-3 font-mono text-sm"
      >
        {row.original.id}
      </Typography>
    ),
    size: 44,
  },
  {
    accessorKey: "status",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>
    ),
    size: 28,
    filterFn: (row, _id, value) => {
      return Array.isArray(value) && value.includes(row.original.status)
    },
  },
  {
    accessorKey: "workloadId",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Workload" />,
    cell: ({ row }) => (
      <div className="flex min-w-0 flex-col gap-1">
        <Typography variant="p" affects="removePaddingMargin" className="truncate text-sm">
          {row.original.workloadId ?? "Unscoped"}
        </Typography>
        <Typography
          variant="p"
          affects="removePaddingMargin"
          className="truncate text-muted-foreground text-xs"
        >
          {row.original.workloadType ?? "custom"}
        </Typography>
      </div>
    ),
    size: 48,
  },
  {
    accessorKey: "budgetAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Budget" />,
    cell: ({ row }) => (
      <Badge>{formatRunMoney(row.original.budgetAmount, row.original.currency)}</Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "consumedAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Consumed" />,
    cell: ({ row }) => (
      <Badge variant="outline">
        {formatRunMoney(row.original.consumedAmount, row.original.currency)}
      </Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "startedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {formatRunDate(row.original.startedAt)}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "endedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ended" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {formatRunDate(row.original.endedAt)}
      </Typography>
    ),
    size: 40,
  },
]
