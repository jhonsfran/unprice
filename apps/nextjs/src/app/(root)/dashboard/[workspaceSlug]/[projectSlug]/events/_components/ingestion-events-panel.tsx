"use client"

import { Button } from "@unprice/ui/button"
import { FilterDataTable } from "@unprice/ui/filter-data-table"
import { AlertTriangle, Code, RotateCcw } from "lucide-react"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { RejectionReasonsPanel } from "~/components/analytics/rejection-reasons-panel"
import { RequestPathSparkline } from "~/components/analytics/request-path-sparkline"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { IngestionEventDetailsSheet } from "./ingestion-event-details-sheet"
import { IngestionEventsSummarySkeleton } from "./ingestion-events-summary-skeleton"
import { buildIngestionEventsColumns } from "./ingestion-events-table-schema"
import { MAX_REPLAY_IDS, isReplayQueued, useIngestionEventsData } from "./use-ingestion-events-data"

const TABLE_LOADING_STATE = <EmptyPlaceholder className="min-h-[300px] border-none" isLoading />

export function IngestionEventsPanel() {
  const {
    workspaceSlug,
    projectSlug,
    isRefreshing,
    status,
    windowLabel,
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
        searchPlaceholder="Search events, customers, sources, modes, reasons"
        searchValue={searchValue}
        onSearchValueChange={(value) => {
          void setFilters({ page: 1, search: value || null })
        }}
        emptyTitle={queryError ? "Events could not be loaded" : "No events"}
        emptyDescription={
          queryError?.message ??
          "Events appear after your app records or consumes usage. Clear filters to inspect existing evidence."
        }
        emptyState={
          <EmptyPlaceholder className="min-h-[520px] border-none bg-transparent">
            <EmptyPlaceholder.Icon>
              <AlertTriangle className="h-8 w-8" />
            </EmptyPlaceholder.Icon>
            <EmptyPlaceholder.Title>
              {queryError ? "Events could not be loaded" : "No events"}
            </EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {queryError?.message ??
                "Events appear after your app records or consumes usage. Clear filters to inspect existing evidence."}
            </EmptyPlaceholder.Description>
            {!queryError && (
              <EmptyPlaceholder.Action>
                <div className="flex flex-col items-center justify-center gap-2 sm:flex-row">
                  <CodeApiSheet defaultMethod="consumeUsage">
                    <Button size="sm" variant="primary">
                      <Code className="mr-2 size-4" />
                      Report usage synchronously
                    </Button>
                  </CodeApiSheet>
                  <CodeApiSheet defaultMethod="recordUsage">
                    <Button size="sm" variant="default">
                      <Code className="mr-2 size-4" />
                      Report asynchronously
                    </Button>
                  </CodeApiSheet>
                </div>
              </EmptyPlaceholder.Action>
            )}
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
