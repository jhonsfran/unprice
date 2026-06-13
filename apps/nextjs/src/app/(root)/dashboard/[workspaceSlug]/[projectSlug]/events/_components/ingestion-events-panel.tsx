"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { toast } from "@unprice/ui/sonner"
import { Activity, CheckCircle2, RotateCcw, XCircle } from "lucide-react"
import { useParams } from "next/navigation"
import { useCallback, useMemo } from "react"
import type { DateRange } from "react-day-picker"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { manipulateDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import {
  type IngestionEventRow,
  type IngestionStatus,
  buildIngestionEventsColumns,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"

const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const EVENTS_PAGE_SIZE = 50
const MAX_REPLAY_IDS = 50

function resolveWindow(from: number | null, to: number | null): { from: number; to: number } {
  const now = Date.now()
  return {
    from: from ?? now - DEFAULT_WINDOW_MS,
    to: to ?? now,
  }
}

export function IngestionEventsPanel() {
  const trpc = useTRPC()
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()
  const [filters, setFilters] = useFilterDataTable()
  const window = useMemo(() => resolveWindow(filters.from, filters.to), [filters.from, filters.to])

  // Only show date range in the filter UI when explicitly set by the user.
  // The query defaults to last hour via resolveWindow when no date is selected.
  const dateRange = useMemo<DateRange | undefined>(
    () =>
      filters.from || filters.to
        ? {
            from: filters.from ? new Date(filters.from) : undefined,
            to: filters.to ? new Date(filters.to) : undefined,
          }
        : undefined,
    [filters.from, filters.to]
  )

  const query = useInfiniteQuery(
    trpc.analytics.getIngestionStatus.infiniteQueryOptions(
      {
        window,
        limit: EVENTS_PAGE_SIZE,
      },
      {
        initialCursor: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        refetchInterval: 15 * 1000,
        refetchOnWindowFocus: true,
      }
    )
  )
  const replayMutation = useMutation(
    trpc.analytics.replayIngestionEvents.mutationOptions({
      onSuccess: async () => {
        await query.refetch()
      },
    })
  )

  const pages = query.data?.pages ?? []
  const rows = useMemo(() => flattenUniqueEvents(pages), [pages])
  const firstPage = pages[0]
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query
  const handleLoadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return Promise.resolve()
    }

    return fetchNextPage().then(() => undefined)
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  const handleReplay = useCallback(
    async (canonicalAuditIds: string | string[]) => {
      const ids = Array.isArray(canonicalAuditIds) ? canonicalAuditIds : [canonicalAuditIds]
      const dedupedIds = Array.from(new Set(ids))

      if (dedupedIds.length === 0) {
        return
      }

      if (dedupedIds.length > MAX_REPLAY_IDS) {
        const message = `Select ${MAX_REPLAY_IDS} or fewer failed events to replay.`
        toast.error(message)
        throw new Error(message)
      }

      try {
        const result = await replayMutation.mutateAsync({ canonicalAuditIds: dedupedIds })
        toast.success(result.replayed === 1 ? "Replay queued" : `${result.replayed} replays queued`)
      } catch (error) {
        toast.error(getReplayErrorMessage(error))
        throw error
      }
    },
    [replayMutation]
  )

  const today = useMemo(() => new Date(), [])
  const oneMonthAgo = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 1)
    return d
  }, [])

  const filterOptions = useMemo(
    () =>
      buildIngestionEventsFilters(rows, {
        type: "date",
        id: "handledAt",
        label: "Date",
        value: dateRange,
        defaultOpen: true,
        fromDate: oneMonthAgo,
        toDate: today,
        numberOfMonths: 1,
        onChange: (range) => {
          if (!range) {
            void setFilters({ from: null, to: null })
            return
          }
          const next = manipulateDate(range)
          void setFilters({
            from: next.from,
            to: next.to,
          })
        },
      }),
    [dateRange, rows, setFilters, today, oneMonthAgo]
  )

  const processed = firstPage?.totals.processed ?? 0
  const rejected = firstPage?.totals.rejected ?? 0
  const total = firstPage?.totals.total ?? 0

  const windowLabel = useMemo(() => {
    const diffMs = window.to - window.from
    const diffHours = Math.round(diffMs / (1000 * 60 * 60))
    if (diffHours <= 1) return "in the last hour"
    if (diffHours < 24) return `in the last ${diffHours} hours`
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 1) return "today"
    return `in the last ${diffDays} days`
  }, [window.from, window.to])

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Processed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              <NumberTicker value={processed} decimalPlaces={0} startValue={0} />
            </div>
            <p className="text-muted-foreground text-xs">{windowLabel}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Rejected</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              <NumberTicker value={rejected} decimalPlaces={0} startValue={0} />
            </div>
            <p className="text-muted-foreground text-xs">{windowLabel}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Total</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              <NumberTicker value={total} decimalPlaces={0} startValue={0} />
            </div>
            <p className="text-muted-foreground text-xs">{windowLabel}</p>
          </CardContent>
        </Card>
      </div>
      <FilterDataTable
        columns={buildIngestionEventsColumns({
          workspaceSlug,
          projectSlug,
          onReplay: handleReplay,
          isReplayPending: replayMutation.isPending,
        })}
        data={rows}
        getRowId={(row) => row.canonicalAuditId}
        filters={filterOptions}
        searchColumn="eventSlug"
        searchPlaceholder="Search events..."
        emptyTitle={query.error ? "Events could not be loaded" : "No events"}
        emptyDescription={
          query.error?.message ?? "No ingestion events were found for the selected filters."
        }
        getRowClassName={(row) =>
          row.state === "failed"
            ? "bg-destructive/10"
            : row.state === "rejected"
              ? "bg-warning/10"
              : undefined
        }
        toolbarActions={({ clearSelection, selectedRows }) => {
          const replayableRows = selectedRows.filter(
            (row) => row.state === "failed" && row.replayable
          )
          const canonicalAuditIds = Array.from(
            new Set(replayableRows.map((row) => row.canonicalAuditId))
          )

          if (canonicalAuditIds.length === 0) {
            return null
          }

          const isOverReplayLimit = canonicalAuditIds.length > MAX_REPLAY_IDS

          return (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={replayMutation.isPending || isOverReplayLimit}
              onClick={() => {
                void handleReplay(canonicalAuditIds)
                  .then(() => clearSelection())
                  .catch(() => undefined)
              }}
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              {isOverReplayLimit ? `Select ${MAX_REPLAY_IDS} or fewer` : "Replay selected"}
            </Button>
          )
        }}
        initialColumnVisibility={{
          sourceId: false,
          rejectionReason: false,
          eventId: false,
        }}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={handleLoadMore}
      />
    </div>
  )
}

function getReplayErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return "Failed to replay ingestion events"
}

function flattenUniqueEvents(pages: IngestionStatus[]): IngestionEventRow[] {
  const seen = new Set<string>()
  const events: IngestionEventRow[] = []

  for (const page of pages) {
    for (const event of page.recentEvents) {
      if (seen.has(event.canonicalAuditId)) {
        continue
      }

      seen.add(event.canonicalAuditId)
      events.push(event)
    }
  }

  return events
}
