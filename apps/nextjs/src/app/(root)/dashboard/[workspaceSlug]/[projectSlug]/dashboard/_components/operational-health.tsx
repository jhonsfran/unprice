"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Skeleton } from "@unprice/ui/skeleton"
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import {
  EvidenceMetricStrip,
  EvidenceMetricTile,
  EvidenceSection,
} from "~/components/analytics/evidence-panel"
import type { IngestionStatus } from "~/components/analytics/ingestion-health-model"
import { buildIngestionHealthInput } from "~/components/analytics/ingestion-health-query"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useTRPC } from "~/trpc/client"

const OPERATIONAL_HEALTH_REFRESH_MS = 15 * 1000
const OPERATIONAL_HEALTH_SKELETON_METRICS = [
  "success",
  "processed",
  "rejected",
  "failed",
  "attention",
]

function buildEmptyIngestionStatus(
  input: ReturnType<typeof buildIngestionHealthInput>
): IngestionStatus {
  return {
    window: input.window,
    totals: {
      processed: 0,
      rejected: 0,
      failed: 0,
      total: 0,
    },
    successRate: 0,
    freshness: {
      generatedAt: input.window.to,
      dataFrom: null,
      dataTo: null,
      latestHandledAt: null,
      secondsSinceLatest: null,
    },
    live: [],
    rejections: [],
    recentEvents: [],
    facets: {
      states: [],
      eventSlugs: [],
      sourceTypes: [],
      rejectionReasons: [],
      customers: [],
    },
    nextCursor: null,
    answer: "",
    confidence: "low",
    evidence: [],
    warnings: [],
    nextActions: [],
  }
}

export function OperationalHealth({ initialNow }: { initialNow: number }) {
  const trpc = useTRPC()
  const [interval] = useIntervalFilter()
  const [windowNow, setWindowNow] = useState(initialNow)
  const deferredNow = useDeferredValue(windowNow)
  const queryInput = useMemo(
    () => buildIngestionHealthInput({ now: deferredNow, intervalMs: interval.intervalMs }),
    [deferredNow, interval.intervalMs]
  )
  const emptyStatus = useMemo(() => buildEmptyIngestionStatus(queryInput), [queryInput])

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setWindowNow(Date.now())
    }, OPERATIONAL_HEALTH_REFRESH_MS)

    return () => globalThis.clearInterval(intervalId)
  }, [])

  const { data, isFetching } = useSuspenseQuery(
    trpc.analytics.getIngestionStatus.queryOptions(queryInput, {
      placeholderData: (previousData) => previousData ?? emptyStatus,
      staleTime: 15 * 1000,
      refetchOnWindowFocus: true,
    })
  )
  const isInitialPlaceholder = data === emptyStatus

  return (
    <IngestionHealthStrip
      status={data}
      isFetching={isFetching || isInitialPlaceholder}
      title="Operational health"
      description={`Ingestion health for the ${interval.label}. Rejections are business denials; failures need recovery.`}
      className={isInitialPlaceholder ? "animate-pulse" : undefined}
      presentation="section"
      showNoEventsAction={false}
    />
  )
}

export function OperationalHealthSkeleton() {
  return (
    <EvidenceSection
      title={<Skeleton className="h-5 w-44" />}
      badges={
        <>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
        </>
      }
      description={<Skeleton className="h-4 w-[34rem] max-w-full" />}
      actions={<Skeleton className="h-4 w-48" />}
    >
      <EvidenceMetricStrip className="md:grid-cols-5">
        {OPERATIONAL_HEALTH_SKELETON_METRICS.map((metric) => (
          <EvidenceMetricTile
            key={metric}
            label={<Skeleton className="h-3 w-20" />}
            value={<Skeleton className="h-6 w-12" />}
            helper={<Skeleton className="h-3 w-24" />}
            icon={<Skeleton className="size-4" />}
          />
        ))}
      </EvidenceMetricStrip>
    </EvidenceSection>
  )
}
