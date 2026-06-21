"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
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

export const columns: ColumnDef<CustomerRun>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap font-mono text-sm"
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
    accessorKey: "traceId",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Trace" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="max-w-44 truncate font-mono text-xs"
      >
        {row.original.traceId ?? "-"}
      </Typography>
    ),
    size: 36,
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
    accessorKey: "remainingAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Remaining" />,
    cell: ({ row }) => (
      <Badge variant="outline">
        {formatRunMoney(row.original.remainingAmount, row.original.currency)}
      </Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "startedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {format(new Date(row.original.startedAt), "PPpp")}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "endedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ended" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {row.original.endedAt ? format(new Date(row.original.endedAt), "PPpp") : "-"}
      </Typography>
    ),
    size: 40,
  },
]
