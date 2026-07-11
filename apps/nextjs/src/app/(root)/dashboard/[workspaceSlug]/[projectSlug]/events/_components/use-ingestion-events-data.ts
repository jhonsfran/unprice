"use client"

import { useInfiniteQuery } from "@tanstack/react-query"
import { useParams } from "next/navigation"
import { useCallback, useMemo, useState } from "react"
import type { IngestionQueryFilter } from "~/components/analytics/ingestion-health-model"
import { ANALYTICS_REFRESH_INTERVAL_MS } from "~/components/analytics/ingestion-health-query"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import type { DataTableFilterParams } from "~/lib/searchParams"
import { useTRPC } from "~/trpc/client"
import {
  type IngestionEventRow,
  type IngestionEventsFilterId,
  type IngestionEventsFilterValues,
  type IngestionStatus,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"
import { useReplayQueue } from "./use-replay-queue"
import { useRollingWindow } from "./use-rolling-window"

export { MAX_REPLAY_IDS } from "./use-replay-queue"

const EVENTS_PAGE_SIZE = 50
const INGESTION_STATES = ["processed", "rejected", "failed"] as const

export function useIngestionEventsData() {
  const trpc = useTRPC()
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()
  const [filters, setFilters] = useFilterDataTable()
  const [detailsEvent, setDetailsEvent] = useState<IngestionEventRow | null>(null)
  const replayStorageKey = `unprice:events:replay-queued:${workspaceSlug}:${projectSlug}`
  const { queryWindow, hasExplicitDateRange, windowLabel } = useRollingWindow(
    filters.from,
    filters.to
  )
  const filterValues = useMemo(
    () => getIngestionEventsFilterValues(filters.filters),
    [filters.filters]
  )
  const ingestionQueryFilter = useMemo(
    () => buildIngestionQueryFilter(filterValues, filters.search),
    [filterValues, filters.search]
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
        refetchInterval: hasExplicitDateRange ? ANALYTICS_REFRESH_INTERVAL_MS : false,
        refetchOnWindowFocus: true,
      }
    )
  )

  const { queuedReplayIds, pendingReplayIds, blockedReplayIds, handleReplay, replayIsPending } =
    useReplayQueue(replayStorageKey, refetch)

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

  const handleDetailsOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDetailsEvent(null)
    }
  }, [])

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

  const isInitialLoading = isLoading && rows.length === 0
  const isRefreshing = isFetching && !isInitialLoading && !isFetchingNextPage

  return {
    workspaceSlug,
    projectSlug,
    isRefreshing,
    status: firstPage,
    windowLabel,
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
    replayIsPending,
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
