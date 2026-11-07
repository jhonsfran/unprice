"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import type { FilterDataTableFilter, FilterDataTableOption } from "@unprice/ui/filter-data-table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { FileSearch } from "lucide-react"
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

const ingestionModeOptions = [
  {
    label: "Budgeted run",
    value: "run",
  },
  {
    label: "Sync",
    value: "sync",
  },
  {
    label: "Async",
    value: "async",
  },
  {
    label: "Unknown",
    value: "unknown",
  },
] as const

type IngestionEventMode = (typeof ingestionModeOptions)[number]["value"]

export type IngestionEventsFilterId =
  | "state"
  | "eventSlug"
  | "sourceType"
  | "rejectionReason"
  | "customerId"

export type IngestionEventsFilterValues = {
  states: string[]
  eventSlugs: string[]
  sourceTypes: string[]
  rejectionReasons: string[]
  customerIds: string[]
}

function statusBadgeVariant(
  state: IngestionEventRow["state"]
): "success" | "warning" | "destructive" {
  if (state === "processed") {
    return "success"
  }

  return state === "failed" ? "destructive" : "warning"
}

export function getIngestionEventMode(row: IngestionEventRow): IngestionEventMode {
  if (row.runId) {
    return "run"
  }

  return row.ingestionMode ?? "unknown"
}

export function formatIngestionEventModeLabel(row: IngestionEventRow): string {
  const mode = getIngestionEventMode(row)
  return ingestionModeOptions.find((option) => option.value === mode)?.label ?? mode
}

export function buildIngestionEventsColumns(params: {
  workspaceSlug: string
  projectSlug: string
  onViewDetails: (event: IngestionEventRow) => void
}): ColumnDef<IngestionEventRow>[] {
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
      id: "ingestionMode",
      accessorFn: (row) => getIngestionEventMode(row),
      header: "Ingestion mode",
      cell: ({ row }) => (
        <Badge variant={getIngestionEventMode(row.original) === "run" ? "secondary" : "outline"}>
          {formatIngestionEventModeLabel(row.original)}
        </Badge>
      ),
      size: 160,
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
        return (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{row.original.sourceType}</Badge>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="primary"
                    size="xs"
                    aria-label="View event details"
                    onClick={() => params.onViewDetails(row.original)}
                  >
                    <FileSearch className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View details</TooltipContent>
              </Tooltip>
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
      filterFn: (row, id, value) => Array.isArray(value) && value.includes(row.getValue(id)),
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

  return columns
}

export function buildIngestionEventsFilters({
  facets,
  values,
  onChange,
}: {
  facets: IngestionStatus["facets"] | undefined
  values: IngestionEventsFilterValues
  onChange: (id: IngestionEventsFilterId, values: string[]) => void
}): FilterDataTableFilter[] {
  const statusCounts = new Map(facets?.states.map((facet) => [facet.value, facet.count]) ?? [])

  const filters: FilterDataTableFilter[] = [
    {
      type: "checkbox",
      id: "state",
      label: "Status",
      defaultOpen: true,
      showCounts: true,
      value: values.states,
      onChange: (nextValues) => onChange("state", nextValues),
      options: statusOptions.map((option) => ({
        ...option,
        count: statusCounts.get(option.value as IngestionEventRow["state"]) ?? 0,
      })),
    },
    {
      type: "checkbox",
      id: "eventSlug",
      label: "Event",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No events for the selected filters",
      value: values.eventSlugs,
      onChange: (nextValues) => onChange("eventSlug", nextValues),
      options: toFacetOptions(facets?.eventSlugs, values.eventSlugs),
    },
    {
      type: "checkbox",
      id: "sourceType",
      label: "Source",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No sources for the selected filters",
      value: values.sourceTypes,
      onChange: (nextValues) => onChange("sourceType", nextValues),
      options: toFacetOptions(facets?.sourceTypes, values.sourceTypes, formatSourceTypeLabel),
    },
    {
      type: "checkbox",
      id: "rejectionReason",
      label: "Rejection reason",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No rejection reasons for the selected filters",
      value: values.rejectionReasons,
      onChange: (nextValues) => onChange("rejectionReason", nextValues),
      options: toFacetOptions(facets?.rejectionReasons, values.rejectionReasons),
    },
    {
      type: "checkbox",
      id: "customerId",
      label: "Customer",
      showCounts: true,
      hideEmptyOptions: true,
      emptyOptionsLabel: "No customers for the selected filters",
      value: values.customerIds,
      onChange: (nextValues) => onChange("customerId", nextValues),
      options: toFacetOptions(facets?.customers, values.customerIds),
    },
  ]

  // a facet with nothing to pick and nothing picked is dead rail space:
  // status stays as the anchor group, the rest appear with data
  return filters.filter(
    (filter) =>
      filter.type !== "checkbox" ||
      filter.id === "state" ||
      filter.options.length > 0 ||
      (filter.value?.length ?? 0) > 0
  )
}

function toFacetOptions(
  facets: { value: string; count: number }[] | undefined,
  selectedValues: string[],
  formatLabel: (value: string) => string = (value) => value
): FilterDataTableOption[] {
  const options = new Map<string, { label: string; value: string; count: number }>()

  for (const facet of facets ?? []) {
    options.set(facet.value, {
      label: formatLabel(facet.value),
      value: facet.value,
      count: facet.count,
    })
  }

  for (const selectedValue of selectedValues) {
    if (!options.has(selectedValue)) {
      options.set(selectedValue, {
        label: formatLabel(selectedValue),
        value: selectedValue,
        count: 0,
      })
    }
  }

  return Array.from(options.values())
}

function formatSourceTypeLabel(value: string): string {
  return sourceTypeOptions.find((option) => option.value === value)?.label ?? value
}
