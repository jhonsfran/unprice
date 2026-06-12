"use client"

import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { useMemo } from "react"
import type { DateRange } from "react-day-picker"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { manipulateDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import {
  buildIngestionEventsFilters,
  ingestionEventsColumns,
} from "./ingestion-events-table-schema"

const DEFAULT_WINDOW_MS = 60 * 60 * 1000

function resolveWindow(from: number | null, to: number | null): { from: number; to: number } {
  const now = Date.now()
  return {
    from: from ?? now - DEFAULT_WINDOW_MS,
    to: to ?? now,
  }
}

export function IngestionEventsPanel() {
  const trpc = useTRPC()
  const [filters, setFilters] = useFilterDataTable()
  const window = useMemo(() => resolveWindow(filters.from, filters.to), [filters.from, filters.to])
  const dateRange = useMemo<DateRange | undefined>(
    () => ({
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
    }),
    [filters.from, filters.to]
  )

  const query = useQuery(
    trpc.analytics.getIngestionStatus.queryOptions(
      {
        window,
        limit: 100,
      },
      {
        refetchInterval: 15 * 1000,
        refetchOnWindowFocus: true,
      }
    )
  )

  const rows = query.data?.recentEvents ?? []
  const filterOptions = useMemo(
    () =>
      buildIngestionEventsFilters(rows, {
        type: "date",
        id: "handledAt",
        label: "Date",
        value: dateRange,
        defaultOpen: true,
        onChange: (range) => {
          const next = manipulateDate(range)
          void setFilters({
            from: next.from,
            to: next.to,
          })
        },
      }),
    [dateRange, rows, setFilters]
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <StatusCard title="Processed" value={query.data?.totals.processed ?? 0} />
        <StatusCard title="Rejected" value={query.data?.totals.rejected ?? 0} />
        <StatusCard title="Total" value={query.data?.totals.total ?? 0} />
      </div>
      <FilterDataTable
        columns={ingestionEventsColumns}
        data={rows}
        filters={filterOptions}
        searchColumn="eventSlug"
        searchPlaceholder="Search events..."
        emptyTitle={query.error ? "Events could not be loaded" : "No events"}
        emptyDescription={
          query.error?.message ?? "No ingestion events were found for the selected filters."
        }
        getRowClassName={(row) => (row.state === "rejected" ? "bg-destructive/10" : undefined)}
      />
    </div>
  )
}

function StatusCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-medium text-muted-foreground text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-semibold text-2xl tabular-nums">{value}</div>
      </CardContent>
    </Card>
  )
}
