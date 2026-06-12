"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import type { FilterDataTableFilter } from "@unprice/ui/filter-data-table"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"

export type IngestionStatus = RouterOutputs["analytics"]["getIngestionStatus"]
export type IngestionEventRow = IngestionStatus["recentEvents"][number]

const statusOptions = [
  {
    label: "Processed",
    value: "processed",
  },
  {
    label: "Rejected",
    value: "rejected",
  },
]

const sourceTypeOptions = [
  {
    label: "API key",
    value: "api_key",
  },
  {
    label: "System",
    value: "system",
  },
  {
    label: "Unknown",
    value: "unknown",
  },
]

function statusBadgeVariant(state: IngestionEventRow["state"]): "success" | "destructive" {
  return state === "processed" ? "success" : "destructive"
}

export function buildIngestionEventsColumns(params: {
  workspaceSlug: string
  projectSlug: string
}): ColumnDef<IngestionEventRow>[] {
  return [
    {
      accessorKey: "handledAt",
      header: "Handled",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs">
          {formatDate(row.original.handledAt, undefined, "yyyy-MM-dd HH:mm:ss")}
        </span>
      ),
      enableSorting: true,
      size: 180,
    },
    {
      accessorKey: "state",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={statusBadgeVariant(row.original.state)}>
          {row.original.state === "processed" ? "processed" : "rejected"}
        </Badge>
      ),
      filterFn: (row, id, value) => Array.isArray(value) && value.includes(row.getValue(id)),
      size: 120,
    },
    {
      accessorKey: "eventSlug",
      header: "Event",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs">{row.original.eventSlug}</span>
      ),
      filterFn: (row, id, filterValue) => {
        const value = String(row.getValue(id)).toLowerCase()
        return value.includes(String(filterValue).toLowerCase())
      },
      size: 220,
    },
    {
      accessorKey: "customerId",
      header: "Customer",
      cell: ({ row }) => (
        <SuperLink
          href={`/${params.workspaceSlug}/${params.projectSlug}/customers/${row.original.customerId}`}
          className="whitespace-nowrap font-mono text-xs underline-offset-4 hover:underline"
        >
          {row.original.customerId}
        </SuperLink>
      ),
      filterFn: (row, id, filterValue) => {
        const value = String(row.getValue(id)).toLowerCase()
        return value.includes(String(filterValue).toLowerCase())
      },
      size: 200,
    },
    {
      accessorKey: "sourceType",
      header: "Source",
      cell: ({ row }) => <Badge variant="outline">{row.original.sourceType}</Badge>,
      filterFn: (row, id, value) => Array.isArray(value) && value.includes(row.getValue(id)),
      size: 130,
    },
    {
      accessorKey: "sourceId",
      header: "Source ID",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs">{row.original.sourceId}</span>
      ),
      size: 180,
    },
    {
      accessorKey: "rejectionReason",
      header: "Rejection reason",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground text-xs">
          {row.original.rejectionReason ?? "none"}
        </span>
      ),
      size: 220,
    },
    {
      accessorKey: "eventId",
      header: "Event ID",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs">{row.original.eventId}</span>
      ),
      size: 220,
    },
  ]
}

export function buildIngestionEventsFilters(
  rows: IngestionEventRow[],
  dateFilter: Extract<FilterDataTableFilter, { type: "date" }>
): FilterDataTableFilter[] {
  const customerOptions = Array.from(new Set(rows.map((row) => row.customerId)))
    .sort()
    .map((customerId) => ({
      label: customerId,
      value: customerId,
    }))

  return [
    dateFilter,
    {
      type: "checkbox",
      id: "state",
      label: "Status",
      defaultOpen: true,
      options: statusOptions,
    },
    {
      type: "checkbox",
      id: "sourceType",
      label: "Source",
      options: sourceTypeOptions,
    },
    {
      type: "checkbox",
      id: "customerId",
      label: "Customer",
      options: customerOptions,
    },
  ]
}
