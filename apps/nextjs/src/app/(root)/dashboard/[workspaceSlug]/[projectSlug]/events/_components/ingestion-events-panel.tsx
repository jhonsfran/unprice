"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { toast } from "@unprice/ui/sonner"
import { Activity, CheckCircle2, RotateCcw, TriangleAlert, XCircle } from "lucide-react"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { manipulateDate } from "~/lib/dates"
import { useTRPC } from "~/trpc/client"
import { IngestionEventDetailsSheet } from "./ingestion-event-details-sheet"
import {
  type IngestionEventRow,
  type IngestionStatus,
  buildIngestionEventsColumns,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"

const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 15 * 1000
const EVENTS_PAGE_SIZE = 50
const MAX_REPLAY_IDS = 50
const MAX_STORED_REPLAY_IDS = 500

function resolveWindow(
  from: number | null,
  to: number | null,
  now: number
): { from: number; to: number } {
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
  const [detailsEvent, setDetailsEvent] = useState<IngestionEventRow | null>(null)
  const [rollingNow, setRollingNow] = useState(() => Date.now())
  const replayStorageKey = useMemo(
    () => `unprice:events:replay-queued:${workspaceSlug}:${projectSlug}`,
    [workspaceSlug, projectSlug]
  )
  const [queuedReplayIds, setQueuedReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingReplayIds, setPendingReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const hasExplicitDateRange = filters.from !== null || filters.to !== null
  const queryWindow = useMemo(
    () => resolveWindow(filters.from, filters.to, rollingNow),
    [filters.from, filters.to, rollingNow]
  )
  const blockedReplayIds = useMemo(
    () => new Set([...queuedReplayIds, ...pendingReplayIds]),
    [pendingReplayIds, queuedReplayIds]
  )

  useEffect(() => {
    setQueuedReplayIds(new Set(readStoredReplayIds(replayStorageKey)))
  }, [replayStorageKey])

  useEffect(() => {
    if (hasExplicitDateRange) {
      return
    }

    const refresh = () => setRollingNow(Date.now())
    const intervalId = globalThis.setInterval(refresh, AUTO_REFRESH_INTERVAL_MS)
    globalThis.addEventListener("focus", refresh)

    return () => {
      globalThis.clearInterval(intervalId)
      globalThis.removeEventListener("focus", refresh)
    }
  }, [hasExplicitDateRange])

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
        window: queryWindow,
        limit: EVENTS_PAGE_SIZE,
      },
      {
        initialCursor: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        placeholderData: (previousData) => previousData,
        refetchInterval: hasExplicitDateRange ? AUTO_REFRESH_INTERVAL_MS : false,
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
  const hasReplayableRows = useMemo(
    () =>
      rows.some(
        (row) =>
          row.state === "failed" && row.replayable && !blockedReplayIds.has(row.canonicalAuditId)
      ),
    [blockedReplayIds, rows]
  )
  const visibleDetailsEvent = useMemo(() => {
    if (!detailsEvent) {
      return null
    }

    return (
      rows.find((row) => row.canonicalAuditId === detailsEvent.canonicalAuditId) ?? detailsEvent
    )
  }, [detailsEvent, rows])
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
      const dedupedIds = Array.from(new Set(ids)).filter((id) => !blockedReplayIds.has(id))

      if (dedupedIds.length === 0) {
        toast.info("Replay already queued")
        return
      }

      if (dedupedIds.length > MAX_REPLAY_IDS) {
        const message = `Select ${MAX_REPLAY_IDS} or fewer failed events to replay.`
        toast.error(message)
        throw new Error(message)
      }

      setPendingReplayIds((previousIds) => new Set([...previousIds, ...dedupedIds]))

      try {
        const result = await replayMutation.mutateAsync({ canonicalAuditIds: dedupedIds })
        setQueuedReplayIds((previousIds) =>
          persistReplayIds(replayStorageKey, previousIds, dedupedIds)
        )
        toast.success(result.replayed === 1 ? "Replay queued" : `${result.replayed} replays queued`)
      } catch (error) {
        toast.error(getReplayErrorMessage(error))
        throw error
      } finally {
        setPendingReplayIds((previousIds) => removeReplayIds(previousIds, dedupedIds))
      }
    },
    [blockedReplayIds, replayMutation, replayStorageKey]
  )
  const handleDetailsOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDetailsEvent(null)
    }
  }, [])

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
            setRollingNow(Date.now())
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
  const failed = firstPage?.totals.failed ?? 0
  const total = firstPage?.totals.total ?? 0

  const windowLabel = useMemo(() => {
    const diffMs = queryWindow.to - queryWindow.from
    const diffHours = Math.round(diffMs / (1000 * 60 * 60))
    if (diffHours <= 1) return "in the last hour"
    if (diffHours < 24) return `in the last ${diffHours} hours`
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 1) return "today"
    return `in the last ${diffDays} days`
  }, [queryWindow.from, queryWindow.to])

  const isInitialLoading = query.isLoading && rows.length === 0
  const isRefreshing = query.isFetching && !isInitialLoading && !isFetchingNextPage

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
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
            <CardTitle className="font-medium text-sm">Failed</CardTitle>
            <TriangleAlert className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              <NumberTicker value={failed} decimalPlaces={0} startValue={0} />
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
          onViewDetails: setDetailsEvent,
          onReplay: handleReplay,
          queuedReplayIds,
          pendingReplayIds,
          blockedReplayIds,
          isReplayPending: replayMutation.isPending,
          hasReplayableRows,
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
            (row) =>
              row.state === "failed" &&
              row.replayable &&
              !blockedReplayIds.has(row.canonicalAuditId)
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
        isLoading={isInitialLoading}
        isRefreshing={isRefreshing}
        isLoadingMore={isFetchingNextPage}
        loadingLabel="Loading events"
        onLoadMore={handleLoadMore}
      />
      <IngestionEventDetailsSheet
        event={visibleDetailsEvent}
        open={detailsEvent !== null}
        onOpenChange={handleDetailsOpenChange}
        onReplay={handleReplay}
        isReplayQueued={
          visibleDetailsEvent ? queuedReplayIds.has(visibleDetailsEvent.canonicalAuditId) : false
        }
        isReplayPending={
          visibleDetailsEvent
            ? pendingReplayIds.has(visibleDetailsEvent.canonicalAuditId) || replayMutation.isPending
            : replayMutation.isPending
        }
      />
    </div>
  )
}

function readStoredReplayIds(storageKey: string): string[] {
  try {
    const rawValue = window.localStorage.getItem(storageKey)
    if (!rawValue) {
      return []
    }

    const parsedValue: unknown = JSON.parse(rawValue)
    if (!Array.isArray(parsedValue)) {
      return []
    }

    return parsedValue.filter((value): value is string => typeof value === "string")
  } catch {
    return []
  }
}

function persistReplayIds(
  storageKey: string,
  previousIds: ReadonlySet<string>,
  addedIds: string[]
): ReadonlySet<string> {
  const nextIds = Array.from(new Set([...previousIds, ...addedIds])).slice(-MAX_STORED_REPLAY_IDS)

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(nextIds))
  } catch {
    // Storage may be unavailable in private mode; the in-memory block still applies.
  }

  return new Set(nextIds)
}

function removeReplayIds(
  previousIds: ReadonlySet<string>,
  removedIds: string[]
): ReadonlySet<string> {
  const nextIds = new Set(previousIds)
  for (const removedId of removedIds) {
    nextIds.delete(removedId)
  }

  return nextIds
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
