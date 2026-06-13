"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Checkbox } from "@unprice/ui/checkbox"
import type { FilterDataTableFilter } from "@unprice/ui/filter-data-table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { RotateCcw } from "lucide-react"
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
  {
    label: "Failed",
    value: "failed",
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

function statusBadgeVariant(
  state: IngestionEventRow["state"]
): "success" | "warning" | "destructive" {
  if (state === "processed") {
    return "success"
  }

  return state === "failed" ? "destructive" : "warning"
}

function isReplayableFailedRow(row: IngestionEventRow): boolean {
  return row.state === "failed" && row.replayable
}

export function buildIngestionEventsColumns(params: {
  workspaceSlug: string
  projectSlug: string
  onReplay: (canonicalAuditId: string) => Promise<void>
  isReplayPending: boolean
}): ColumnDef<IngestionEventRow>[] {
  return [
    {
      id: "select",
      size: 44,
      header: ({ table }) => {
        const replayableRows = table
          .getFilteredRowModel()
          .rows.filter((row) => isReplayableFailedRow(row.original))
        const hasReplayableRows = replayableRows.length > 0
        const selectedReplayableRows = replayableRows.filter((row) => row.getIsSelected())
        const checked =
          hasReplayableRows && selectedReplayableRows.length === replayableRows.length
            ? true
            : selectedReplayableRows.length > 0
              ? "indeterminate"
              : false

        return (
          <Checkbox
            checked={checked}
            disabled={!hasReplayableRows}
            onCheckedChange={(value) => {
              for (const row of replayableRows) {
                row.toggleSelected(!!value)
              }
            }}
            aria-label="Select replayable failed events"
            className="translate-y-0.5"
          />
        )
      },
      cell: ({ row }) => {
        const canReplay = isReplayableFailedRow(row.original)

        return (
          <Checkbox
            checked={row.getIsSelected()}
            disabled={!canReplay}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select event"
            className="translate-y-0.5"
          />
        )
      },
      enableSorting: false,
      enableHiding: false,
    },
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
        <Badge variant={statusBadgeVariant(row.original.state)}>{row.original.state}</Badge>
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
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        if (!isReplayableFailedRow(row.original)) {
          return null
        }

        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Replay failed event"
                disabled={params.isReplayPending}
                onClick={() => {
                  void params.onReplay(row.original.canonicalAuditId).catch(() => undefined)
                }}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Replay failed event</TooltipContent>
          </Tooltip>
        )
      },
      enableSorting: false,
      enableHiding: false,
      size: 52,
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
