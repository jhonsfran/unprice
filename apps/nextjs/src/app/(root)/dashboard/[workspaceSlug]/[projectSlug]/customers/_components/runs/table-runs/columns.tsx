"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatLedgerMoney } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { useParams } from "next/navigation"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"

type CustomerRun = RouterOutputs["customers"]["getRuns"]["runs"][number]
type ProjectRun = RouterOutputs["customers"]["listRunsByActiveProject"]["runs"][number]
type RunRow = CustomerRun | ProjectRun

function statusVariant(status: RunRow["status"]) {
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

function formatRunDate(date: RunRow["startedAt"] | RunRow["endedAt"]): string {
  if (!date) {
    return "-"
  }

  return `${formatDate(new Date(date).getTime(), "UTC", "yyyy-MM-dd HH:mm:ss")} UTC`
}

function RunCustomerCell({ row }: { row: { original: RunRow } }) {
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()
  const customer = "customer" in row.original ? row.original.customer : null

  return (
    <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/${row.original.customerId}`}>
      <div className="flex min-w-0 flex-col gap-1">
        {customer ? (
          <>
            <Typography variant="p" affects="removePaddingMargin" className="truncate text-sm">
              {customer.name}
            </Typography>
            <Typography
              variant="p"
              affects="removePaddingMargin"
              className="truncate font-mono text-muted-foreground text-xs"
            >
              {customer.email}
            </Typography>
          </>
        ) : (
          <Typography
            variant="p"
            affects="removePaddingMargin"
            className="truncate font-mono text-sm"
          >
            {row.original.customerId}
          </Typography>
        )}
      </div>
    </SuperLink>
  )
}

export const columns: ColumnDef<RunRow>[] = [
  {
    accessorKey: "customerId",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
    cell: ({ row }) => <RunCustomerCell row={row} />,
    size: 56,
    filterFn: (row, _id, filterValue) => {
      const searchValue = String(filterValue).toLowerCase()
      const customer = "customer" in row.original ? row.original.customer : null

      return Boolean(
        row.original.customerId.toLowerCase().includes(searchValue) ||
          row.original.id.toLowerCase().includes(searchValue) ||
          row.original.traceId?.toLowerCase().includes(searchValue) ||
          row.original.workloadId?.toLowerCase().includes(searchValue) ||
          customer?.email.toLowerCase().includes(searchValue) ||
          customer?.name.toLowerCase().includes(searchValue)
      )
    },
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
    accessorKey: "statusReason",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
    cell: ({ row }) => {
      const reason = row.original.statusReason?.trim()

      return (
        <Typography
          variant="p"
          affects="removePaddingMargin"
          className="max-w-[22rem] truncate text-muted-foreground text-sm"
          title={reason || undefined}
        >
          {reason || "-"}
        </Typography>
      )
    },
    size: 52,
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
    // money is tabular text, not a chip
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-mono text-xs tabular-nums">
        {formatLedgerMoney(row.original.budgetAmount, row.original.currency)}
      </span>
    ),
    size: 28,
  },
  {
    accessorKey: "consumedAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Consumed" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-mono text-xs tabular-nums">
        {formatLedgerMoney(row.original.consumedAmount, row.original.currency)}
      </span>
    ),
    size: 28,
  },
  {
    accessorKey: "startedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap font-mono text-xs tabular-nums"
      >
        {formatRunDate(row.original.startedAt)}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "endedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Ended" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap font-mono text-xs tabular-nums"
      >
        {formatRunDate(row.original.endedAt)}
      </Typography>
    ),
    size: 40,
  },
]
