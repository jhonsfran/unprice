"use client"

import { useInfiniteQuery, useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Skeleton } from "@unprice/ui/skeleton"
import { toast } from "@unprice/ui/sonner"
import { format } from "date-fns"
import { AlertTriangle, CalendarDays, RotateCcw, X } from "lucide-react"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import {
  EvidenceFrame,
  EvidenceMetricStrip,
  EvidenceMetricTile,
  EvidenceSection,
} from "~/components/analytics/evidence-panel"
import type { IngestionQueryFilter } from "~/components/analytics/ingestion-health-model"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { RejectionReasonsPanel } from "~/components/analytics/rejection-reasons-panel"
import { RequestPathSparkline } from "~/components/analytics/request-path-sparkline"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { manipulateDate } from "~/lib/dates"
import type { DataTableFilterParams } from "~/lib/searchParams"
import { useTRPC } from "~/trpc/client"
import { IngestionEventDetailsSheet } from "./ingestion-event-details-sheet"
import {
  type IngestionEventRow,
  type IngestionEventsFilterId,
  type IngestionEventsFilterValues,
  type IngestionStatus,
  buildIngestionEventsColumns,
  buildIngestionEventsFilters,
} from "./ingestion-events-table-schema"

const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 15 * 1000
const EVENTS_PAGE_SIZE = 50
const MAX_REPLAY_IDS = 50
const MAX_STORED_REPLAY_IDS = 500
const INGESTION_STATES = ["processed", "rejected", "failed"] as const
const INGESTION_SUMMARY_METRICS = ["Success", "Processed", "Rejected", "Failed", "Attention"]

const TABLE_LOADING_STATE = <EmptyPlaceholder className="min-h-[300px] border-none" isLoading />
const INGESTION_SUMMARY_SKELETON_BADGES = (
  <>
    <Skeleton className="h-5 w-20" />
    <Skeleton className="h-5 w-20" />
  </>
)
const INGESTION_SUMMARY_SKELETON_ACTIONS = <Skeleton className="h-4 w-48" />
const INGESTION_SUMMARY_SKELETON_VALUE = <Skeleton className="h-7 w-16" />
const INGESTION_SUMMARY_SKELETON_HELPER = <Skeleton className="h-3 w-24" />
const INGESTION_SUMMARY_SKELETON_ICON = <Skeleton className="size-4 rounded-full" />

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

export function IngestionEventsPanel() {
  const {
    workspaceSlug,
    projectSlug,
    isRefreshing,
    status,
    windowLabel,
    dateRange,
    handleDateRangeChange,
    rows,
    filterOptions,
    handleRejectionFilterSelect,
    searchValue,
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
  } = useIngestionEventsData()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <EventsTimeWindowFilter value={dateRange} onChange={handleDateRangeChange} />
      </div>
      {status ? (
        <>
          <IngestionHealthStrip
            status={status}
            isFetching={isRefreshing}
            title="Ingestion health"
            description={`Events ${windowLabel}. Rejections are business denials; failures need recovery.`}
            presentation="section"
            showNoEventsAction={false}
          />
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <RequestPathSparkline
              live={status.live}
              window={status.window}
              presentation="section"
            />
            <RejectionReasonsPanel
              rejections={status.rejections}
              onSelectFilter={handleRejectionFilterSelect}
              presentation="section"
            />
          </div>
        </>
      ) : isInitialLoading ? (
        <IngestionEventsSummarySkeleton windowLabel={windowLabel} />
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
        searchPlaceholder="Search events, customers, sources, reasons"
        searchValue={searchValue}
        onSearchValueChange={(value) => {
          void setFilters({ page: 1, search: value || null })
        }}
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
        presentation="workbench"
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

function IngestionEventsSummarySkeleton({ windowLabel }: { windowLabel: string }) {
  return (
    <>
      <EvidenceSection
        title="Ingestion health"
        description={`Events ${windowLabel}. Rejections are business denials; failures need recovery.`}
        badges={INGESTION_SUMMARY_SKELETON_BADGES}
        actions={INGESTION_SUMMARY_SKELETON_ACTIONS}
      >
        <EvidenceMetricStrip className="md:grid-cols-5">
          {INGESTION_SUMMARY_METRICS.map((label) => (
            <EvidenceMetricTile
              key={label}
              label={label}
              value={INGESTION_SUMMARY_SKELETON_VALUE}
              helper={INGESTION_SUMMARY_SKELETON_HELPER}
              icon={INGESTION_SUMMARY_SKELETON_ICON}
            />
          ))}
        </EvidenceMetricStrip>
        <IngestionActionSlotSkeleton />
      </EvidenceSection>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <EvidenceSection
          title="Request path"
          description="Processed, rejected, and failed ingestion events by second."
          contentClassName="mt-3"
          titleClassName="text-base"
        >
          <EvidenceFrame>
            <Skeleton className="h-full w-full rounded-none" />
          </EvidenceFrame>
        </EvidenceSection>
        <EvidenceSection
          title="Top rejection reasons"
          description="Business denials grouped by reason, event, and source."
          contentClassName="mt-3"
          titleClassName="text-base"
        >
          <EvidenceFrame className="flex flex-col gap-3 p-3">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </EvidenceFrame>
        </EvidenceSection>
      </div>
    </>
  )
}

function IngestionActionSlotSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-md border border-border/60 bg-card/40 px-3 py-2">
      <Skeleton className="h-5 w-full max-w-xl" />
    </div>
  )
}

function EventsTimeWindowFilter({
  value,
  onChange,
}: {
  value?: DateRange
  onChange: (range: DateRange | undefined) => void
}) {
  const hasExplicitValue = Boolean(value?.from || value?.to)

  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-44 justify-start gap-2 font-medium text-xs"
          >
            <CalendarDays className="size-4" />
            <span className="truncate">{formatDateRangeLabel(value)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            initialFocus
            mode="range"
            selected={value}
            onSelect={onChange}
            numberOfMonths={1}
            fromDate={oneMonthAgo()}
            toDate={today()}
            disabled={{ after: today() }}
          />
        </PopoverContent>
      </Popover>
      {hasExplicitValue ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Clear time window"
          onClick={() => onChange(undefined)}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}

function formatDateRangeLabel(range?: DateRange): string {
  if (!range?.from) {
    return "Last hour"
  }

  if (!range.to) {
    return format(range.from, "LLL dd, y")
  }

  return `${format(range.from, "LLL dd, y")} - ${format(range.to, "LLL dd, y")}`
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
