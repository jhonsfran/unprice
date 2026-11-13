"use client"

import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useParams } from "next/navigation"
import { useCallback, useMemo, useState } from "react"
import type { IngestionQueryFilter } from "~/components/analytics/ingestion-health-model"
import { ANALYTICS_REFRESH_INTERVAL_MS } from "~/components/analytics/ingestion-health-query"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import type { DataTableFilterParams } from "~/lib/searchParams"
import { useTRPC } from "~/trpc/client"
import { flattenUniqueEvents, ingestionEventKey } from "./ingestion-event-rows"
import {
  type IngestionEventRow,
  type IngestionEventsFilterId,
  type IngestionEventsFilterValues,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"
import { useRollingWindow } from "./use-rolling-window"

const EVENTS_PAGE_SIZE = 50

export function useIngestionEventsData() {
  const trpc = useTRPC()
  const { workspaceSlug, projectSlug } = useParams<{
    workspaceSlug: string
    projectSlug: string
  }>()
  const [filters, setFilters] = useFilterDataTable()
  const [detailsEvent, setDetailsEvent] = useState<IngestionEventRow | null>(null)
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
    data: status,
    isLoading: isSummaryLoading,
    isFetching: isSummaryFetching,
    error: summaryError,
  } = useQuery(
    trpc.analytics.getIngestionSummary.queryOptions(
      {
        window: queryWindow,
        filter: ingestionQueryFilter,
        limit: EVENTS_PAGE_SIZE,
      },
      {
        placeholderData: (previousData) => previousData,
        refetchInterval: hasExplicitDateRange ? ANALYTICS_REFRESH_INTERVAL_MS : false,
        refetchOnWindowFocus: true,
      }
    )
  )

  const {
    data: queryData,
    isLoading,
    isFetching,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    trpc.analytics.listIngestionEvents.infiniteQueryOptions(
      {
        scope: { window: queryWindow, filter: ingestionQueryFilter },
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

  const pages = queryData?.pages
  const rows = useMemo(() => flattenUniqueEvents(pages ?? []), [pages])
  const visibleDetailsEvent = useMemo(() => {
    if (!detailsEvent) {
      return null
    }

    return (
      rows.find((row) => ingestionEventKey(row) === ingestionEventKey(detailsEvent)) ?? detailsEvent
    )
  }, [detailsEvent, rows])
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
        facets: status?.facets,
        values: filterValues,
        onChange: handleFilterChange,
      }),
    [filterValues, status?.facets, handleFilterChange]
  )

  const isInitialLoading = (isLoading || isSummaryLoading) && rows.length === 0
  const isRefreshing = (isFetching || isSummaryFetching) && !isInitialLoading && !isFetchingNextPage

  return {
    workspaceSlug,
    projectSlug,
    isRefreshing,
    status,
    windowLabel,
    rows,
    filterOptions,
    handleRejectionFilterSelect,
    searchValue: filters.search ?? "",
    setFilters,
    queryError: queryError ?? summaryError,
    isInitialLoading,
    isFetchingNextPage,
    hasNextPage,
    handleLoadMore,
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
  return value === "processed" || value === "rejected"
}
