"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Checkbox } from "@unprice/ui/checkbox"
import type { FilterDataTableFilter } from "@unprice/ui/filter-data-table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { CheckCircle2, FileSearch, Loader2, RotateCcw } from "lucide-react"
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

function isReplayableFailedRow(
  row: IngestionEventRow,
  queuedReplayIds: ReadonlySet<string>
): boolean {
  return row.state === "failed" && row.replayable && !queuedReplayIds.has(row.canonicalAuditId)
}

function isReplayBlockedFailedRow(row: IngestionEventRow, replayIds: ReadonlySet<string>): boolean {
  return row.state === "failed" && row.replayable && replayIds.has(row.canonicalAuditId)
}

export function buildIngestionEventsColumns(params: {
  workspaceSlug: string
  projectSlug: string
  onViewDetails: (event: IngestionEventRow) => void
  onReplay: (canonicalAuditId: string) => Promise<void>
  queuedReplayIds: ReadonlySet<string>
  pendingReplayIds: ReadonlySet<string>
  blockedReplayIds: ReadonlySet<string>
  isReplayPending: boolean
  hasReplayableRows: boolean
}): ColumnDef<IngestionEventRow>[] {
  const selectionColumn: ColumnDef<IngestionEventRow> = {
    id: "select",
    size: 44,
    header: ({ table }) => {
      const replayableRows = table
        .getFilteredRowModel()
        .rows.filter((row) => isReplayableFailedRow(row.original, params.blockedReplayIds))
      const hasReplayableRows = replayableRows.length > 0
      const selectedReplayableRows = replayableRows.filter((row) => row.getIsSelected())
      const checked =
        hasReplayableRows && selectedReplayableRows.length === replayableRows.length
          ? true
          : selectedReplayableRows.length > 0
            ? "indeterminate"
            : false

      return (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={checked}
            disabled={!hasReplayableRows}
            onCheckedChange={(value) => {
              for (const row of replayableRows) {
                row.toggleSelected(!!value)
              }
            }}
            aria-label="Select replayable failed events"
          />
        </div>
      )
    },
    cell: ({ row }) => {
      const canReplay = isReplayableFailedRow(row.original, params.blockedReplayIds)

      if (!canReplay) {
        return null
      }

      return (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select replayable failed event"
          />
        </div>
      )
    },
    enableSorting: false,
    enableHiding: false,
  }

  const columns: ColumnDef<IngestionEventRow>[] = [
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
      cell: ({ row }) => {
        const isReplayQueued = isReplayBlockedFailedRow(row.original, params.queuedReplayIds)
        const isReplayPending = isReplayBlockedFailedRow(row.original, params.pendingReplayIds)
        const canReplay = isReplayableFailedRow(row.original, params.blockedReplayIds)

        return (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{row.original.sourceType}</Badge>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label="View event details"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => params.onViewDetails(row.original)}
                  >
                    <FileSearch className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View details</TooltipContent>
              </Tooltip>
              {canReplay ? (
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
              ) : isReplayPending ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label="Replay is being queued"
                      disabled
                      className="text-muted-foreground"
                    >
                      <Loader2 className="size-3.5 animate-spin" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Replay is being queued</TooltipContent>
                </Tooltip>
              ) : isReplayQueued ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="gap-1 font-normal">
                      <CheckCircle2 className="size-3" />
                      queued
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>Replay already queued from this browser</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        )
      },
      filterFn: (row, id, value) => Array.isArray(value) && value.includes(row.getValue(id)),
      size: 170,
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

  return params.hasReplayableRows ? [selectionColumn, ...columns] : columns
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
      showCounts: true,
      options: statusOptions,
    },
    {
      type: "checkbox",
      id: "sourceType",
      label: "Source",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No sources for the selected filters",
      options: sourceTypeOptions,
    },
    {
      type: "checkbox",
      id: "customerId",
      label: "Customer",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No customers for the selected filters",
      options: customerOptions,
    },
  ]
}
