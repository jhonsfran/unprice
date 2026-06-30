"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { toast } from "@unprice/ui/sonner"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import {
  type SelectedIngestionFilter,
  getSelectedIngestionQueryFilter,
} from "~/components/analytics/ingestion-events-filter-model"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { RejectionReasonsPanel } from "~/components/analytics/rejection-reasons-panel"
import { RequestPathSparkline } from "~/components/analytics/request-path-sparkline"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
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

const TABLE_LOADING_STATE = <EmptyPlaceholder className="min-h-[300px] border-none" isLoading />

function today(): Date {
  return new Date()
}

function oneMonthAgo(): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d
}

function computeWindowLabel(from: number, to: number): string {
  const diffMs = to - from
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  if (diffHours <= 1) return "in the last hour"
  if (diffHours < 24) return `in the last ${diffHours} hours`
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 1) return "today"
  return `in the last ${diffDays} days`
}

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

function useIngestionEventsData() {
  const trpc = useTRPC()
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()
  const [filters, setFilters] = useFilterDataTable()
  const [detailsEvent, setDetailsEvent] = useState<IngestionEventRow | null>(null)
  const [rollingNow, setRollingNow] = useState(() => Date.now())
  const replayStorageKey = `unprice:events:replay-queued:${workspaceSlug}:${projectSlug}`
  const [queuedReplayIds, setQueuedReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingReplayIds, setPendingReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedIngestionFilter, setSelectedIngestionFilter] =
    useState<SelectedIngestionFilter | null>(null)
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

  const {
    data: queryData,
    refetch,
    isLoading,
    isFetching,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    trpc.analytics.getIngestionStatus.infiniteQueryOptions(
      {
        window: queryWindow,
        filter: getSelectedIngestionQueryFilter(selectedIngestionFilter),
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
        await refetch()
      },
    })
  )

  const pages = queryData?.pages
  const rows = useMemo(() => flattenUniqueEvents(pages ?? []), [pages])
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
  const firstPage = pages?.[0]
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

  const filterOptions = useMemo(
    () =>
      buildIngestionEventsFilters(rows, {
        type: "date",
        id: "handledAt",
        label: "Date",
        value: dateRange,
        defaultOpen: true,
        fromDate: oneMonthAgo(),
        toDate: today(),
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
    [dateRange, rows, setFilters]
  )

  const windowLabel = computeWindowLabel(queryWindow.from, queryWindow.to)

  const isInitialLoading = isLoading && rows.length === 0
  const isRefreshing = isFetching && !isInitialLoading && !isFetchingNextPage

  return {
    workspaceSlug,
    projectSlug,
    freshnessGeneratedAt: firstPage?.freshness.generatedAt,
    isRefreshing,
    status: firstPage,
    selectedIngestionFilter,
    setSelectedIngestionFilter,
    windowLabel,
    rows,
    filterOptions,
    searchValue: filters.search ?? "",
    setFilters,
    initialColumnFilters: filters.search
      ? [{ id: "eventSlug" as const, value: filters.search }]
      : [],
    queryError,
    isInitialLoading,
    isFetchingNextPage,
    hasNextPage,
    handleLoadMore,
    handleReplay,
    replayIsPending: replayMutation.isPending,
    blockedReplayIds,
    hasReplayableRows,
    queuedReplayIds,
    pendingReplayIds,
    visibleDetailsEvent,
    detailsEvent,
    setDetailsEvent,
    handleDetailsOpenChange,
  }
}

export function IngestionEventsPanel() {
  const {
    workspaceSlug,
    projectSlug,
    freshnessGeneratedAt,
    isRefreshing,
    status,
    selectedIngestionFilter,
    setSelectedIngestionFilter,
    windowLabel,
    rows,
    filterOptions,
    searchValue,
    setFilters,
    initialColumnFilters,
    queryError,
    isInitialLoading,
    isFetchingNextPage,
    hasNextPage,
    handleLoadMore,
    handleReplay,
    replayIsPending,
    blockedReplayIds,
    hasReplayableRows,
    queuedReplayIds,
    pendingReplayIds,
    visibleDetailsEvent,
    detailsEvent,
    setDetailsEvent,
    handleDetailsOpenChange,
  } = useIngestionEventsData()

  return (
    <div className="space-y-6">
      <div className="flex min-h-4 items-center justify-end">
        <FreshnessIndicator generatedAt={freshnessGeneratedAt} isFetching={isRefreshing} />
      </div>
      {status ? (
        <>
          <IngestionHealthStrip
            status={status}
            isFetching={isRefreshing}
            title="Ingestion health"
            description={`Events ${windowLabel}. Rejections are business denials; failures need recovery.`}
          />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <RequestPathSparkline live={status.live} />
            <RejectionReasonsPanel
              rejections={status.rejections}
              onSelectFilter={(selection) => {
                setSelectedIngestionFilter(selection)
                void setFilters({ search: selection.search })
              }}
            />
          </div>
        </>
      ) : null}
      {selectedIngestionFilter ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span>
            Showing rejected events for{" "}
            <span className="font-mono">{selectedIngestionFilter.label}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedIngestionFilter(null)
              void setFilters({ search: null })
            }}
          >
            Clear filter
          </Button>
        </div>
      ) : null}
      <FilterDataTable
        columns={buildIngestionEventsColumns({
          workspaceSlug,
          projectSlug,
          onViewDetails: setDetailsEvent,
          onReplay: handleReplay,
          queuedReplayIds,
          pendingReplayIds,
          blockedReplayIds,
          isReplayPending: replayIsPending,
          hasReplayableRows,
        })}
        data={rows}
        getRowId={(row) => row.canonicalAuditId}
        filters={filterOptions}
        searchColumn="eventSlug"
        searchPlaceholder="Search events"
        searchValue={searchValue}
        onSearchValueChange={(value) => {
          void setFilters({ search: value || null })
        }}
        initialColumnFilters={initialColumnFilters}
        emptyTitle={queryError ? "Events could not be loaded" : "No events"}
        emptyDescription={
          queryError?.message ?? "No ingestion events were found for the selected filters."
        }
        emptyState={
          <EmptyPlaceholder className="min-h-[520px] border-none">
            <EmptyPlaceholder.Icon>
              <AlertTriangle className="h-8 w-8" />
            </EmptyPlaceholder.Icon>
            <EmptyPlaceholder.Title>
              {queryError ? "Events could not be loaded" : "No events"}
            </EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {queryError?.message ?? "No ingestion events were found for the selected filters."}
            </EmptyPlaceholder.Description>
          </EmptyPlaceholder>
        }
        loadingState={TABLE_LOADING_STATE}
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
              disabled={replayIsPending || isOverReplayLimit}
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
          visibleDetailsEvent ? isReplayQueued(visibleDetailsEvent, queuedReplayIds) : false
        }
        isReplayPending={
          visibleDetailsEvent
            ? isReplayQueued(visibleDetailsEvent, pendingReplayIds) || replayIsPending
            : replayIsPending
        }
      />
    </div>
  )
}

function isReplayQueued(row: IngestionEventRow, replayIds: ReadonlySet<string>): boolean {
  return row.state === "failed" && row.replayable && replayIds.has(row.canonicalAuditId)
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
