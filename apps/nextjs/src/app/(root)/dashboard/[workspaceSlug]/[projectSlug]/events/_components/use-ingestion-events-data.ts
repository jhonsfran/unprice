"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { toast } from "@unprice/ui/sonner"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import type { IngestionQueryFilter } from "~/components/analytics/ingestion-health-model"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { manipulateDate } from "~/lib/dates"
import type { DataTableFilterParams } from "~/lib/searchParams"
import { useTRPC } from "~/trpc/client"
import {
  type IngestionEventRow,
  type IngestionEventsFilterId,
  type IngestionEventsFilterValues,
  type IngestionStatus,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"

const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 15 * 1000
const EVENTS_PAGE_SIZE = 50
const MAX_STORED_REPLAY_IDS = 500
const INGESTION_STATES = ["processed", "rejected", "failed"] as const

export const MAX_REPLAY_IDS = 50

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

export function useIngestionEventsData() {
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
  const hasExplicitDateRange = filters.from !== null || filters.to !== null
  const queryWindow = useMemo(
    () => resolveWindow(filters.from, filters.to, rollingNow),
    [filters.from, filters.to, rollingNow]
  )
  const filterValues = useMemo(
    () => getIngestionEventsFilterValues(filters.filters),
    [filters.filters]
  )
  const ingestionQueryFilter = useMemo(
    () => buildIngestionQueryFilter(filterValues, filters.search),
    [filterValues, filters.search]
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

  // Only show a custom date range when explicitly set by the user.
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
        filter: ingestionQueryFilter,
        includeFacets: true,
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

  const handleDateRangeChange = useCallback(
    (range: DateRange | undefined) => {
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
    [setFilters]
  )

  const handleFilterChange = useCallback(
    (id: IngestionEventsFilterId, values: string[]) => {
      const nextFilters = updateFilterValues(filters.filters, id, values)

      void setFilters({
        page: 1,
        filters: Object.keys(nextFilters).length > 0 ? nextFilters : null,
      })
    },
    [filters.filters, setFilters]
  )

  const handleRejectionFilterSelect = useCallback(
    (selection: { eventSlug: string; sourceType: string; rejectionReason: string | null }) => {
      const nextFilters: DataTableFilterParams = {
        ...filters.filters,
        state: ["rejected"],
        eventSlug: [selection.eventSlug],
        sourceType: [selection.sourceType],
      }

      if (selection.rejectionReason) {
        nextFilters.rejectionReason = [selection.rejectionReason]
      } else {
        delete nextFilters.rejectionReason
      }

      void setFilters({
        page: 1,
        search: null,
        filters: nextFilters,
      })
    },
    [filters.filters, setFilters]
  )

  const filterOptions = useMemo(
    () =>
      buildIngestionEventsFilters({
        facets: firstPage?.facets,
        values: filterValues,
        onChange: handleFilterChange,
      }),
    [filterValues, firstPage?.facets, handleFilterChange]
  )

  const windowLabel = computeWindowLabel(queryWindow.from, queryWindow.to)

  const isInitialLoading = isLoading && rows.length === 0
  const isRefreshing = isFetching && !isInitialLoading && !isFetchingNextPage

  return {
    workspaceSlug,
    projectSlug,
    isRefreshing,
    status: firstPage,
    windowLabel,
    dateRange,
    handleDateRangeChange,
    rows,
    filterOptions,
    handleRejectionFilterSelect,
    searchValue: filters.search ?? "",
    setFilters,
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

function getIngestionEventsFilterValues(
  filterParams: DataTableFilterParams
): IngestionEventsFilterValues {
  return {
    states: getStringFilterValues(filterParams, "state"),
    eventSlugs: getStringFilterValues(filterParams, "eventSlug"),
    sourceTypes: getStringFilterValues(filterParams, "sourceType"),
    rejectionReasons: getStringFilterValues(filterParams, "rejectionReason"),
    customerIds: getStringFilterValues(filterParams, "customerId"),
  }
}

function getStringFilterValues(
  filterParams: DataTableFilterParams,
  id: IngestionEventsFilterId
): string[] {
  return (filterParams[id] ?? []).filter(
    (value): value is string => typeof value === "string" && value.length > 0
  )
}

function buildIngestionQueryFilter(
  values: IngestionEventsFilterValues,
  search: string | null
): IngestionQueryFilter {
  const queryFilter: IngestionQueryFilter = {}
  const states = values.states.filter(isIngestionState)
  const searchValue = search?.trim()

  if (states.length > 0) {
    queryFilter.states = states
  }

  if (values.eventSlugs.length > 0) {
    queryFilter.eventSlugs = values.eventSlugs
  }

  if (values.sourceTypes.length > 0) {
    queryFilter.sourceTypes = values.sourceTypes
  }

  if (values.rejectionReasons.length > 0) {
    queryFilter.rejectionReasons = values.rejectionReasons
  }

  if (values.customerIds.length > 0) {
    queryFilter.customerIds = values.customerIds
  }

  if (searchValue) {
    queryFilter.search = searchValue
  }

  return queryFilter
}

function updateFilterValues(
  filterParams: DataTableFilterParams,
  id: IngestionEventsFilterId,
  values: string[]
): DataTableFilterParams {
  const nextFilters: DataTableFilterParams = { ...filterParams }
  const nextValues = Array.from(new Set(values.filter((value) => value.length > 0)))

  if (nextValues.length > 0) {
    nextFilters[id] = nextValues
  } else {
    delete nextFilters[id]
  }

  return nextFilters
}

function isIngestionState(
  value: string
): value is NonNullable<IngestionQueryFilter["states"]>[number] {
  return INGESTION_STATES.includes(value as (typeof INGESTION_STATES)[number])
}

export function isReplayQueued(row: IngestionEventRow, replayIds: ReadonlySet<string>): boolean {
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
