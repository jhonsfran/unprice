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

const OPERATIONAL_HEALTH_SKELETON_TITLE = <Skeleton className="h-5 w-44" />
const OPERATIONAL_HEALTH_SKELETON_BADGES = (
  <>
    <Skeleton className="h-5 w-20" />
    <Skeleton className="h-5 w-24" />
  </>
)
const OPERATIONAL_HEALTH_SKELETON_DESCRIPTION = <Skeleton className="h-4 w-[34rem] max-w-full" />
const OPERATIONAL_HEALTH_SKELETON_ACTIONS = <Skeleton className="h-4 w-48" />
const OPERATIONAL_HEALTH_SKELETON_LABEL = <Skeleton className="h-3 w-20" />
const OPERATIONAL_HEALTH_SKELETON_VALUE = <Skeleton className="h-6 w-12" />
const OPERATIONAL_HEALTH_SKELETON_HELPER = <Skeleton className="h-3 w-24" />
const OPERATIONAL_HEALTH_SKELETON_ICON = <Skeleton className="size-4" />

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
      title={OPERATIONAL_HEALTH_SKELETON_TITLE}
      badges={OPERATIONAL_HEALTH_SKELETON_BADGES}
      description={OPERATIONAL_HEALTH_SKELETON_DESCRIPTION}
      actions={OPERATIONAL_HEALTH_SKELETON_ACTIONS}
    >
      <EvidenceMetricStrip className="md:grid-cols-5">
        {OPERATIONAL_HEALTH_SKELETON_METRICS.map((metric) => (
          <EvidenceMetricTile
            key={metric}
            label={OPERATIONAL_HEALTH_SKELETON_LABEL}
            value={OPERATIONAL_HEALTH_SKELETON_VALUE}
            helper={OPERATIONAL_HEALTH_SKELETON_HELPER}
            icon={OPERATIONAL_HEALTH_SKELETON_ICON}
          />
        ))}
      </EvidenceMetricStrip>
    </EvidenceSection>
  )
}
