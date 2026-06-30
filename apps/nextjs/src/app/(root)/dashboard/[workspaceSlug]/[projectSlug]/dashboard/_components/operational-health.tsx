"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Skeleton } from "@unprice/ui/skeleton"
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { buildIngestionHealthInput } from "~/components/analytics/ingestion-health-query"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { useTRPC } from "~/trpc/client"

const OPERATIONAL_HEALTH_REFRESH_MS = 15 * 1000

export function OperationalHealth({ initialNow }: { initialNow: number }) {
  const trpc = useTRPC()
  const [windowNow, setWindowNow] = useState(initialNow)
  const deferredNow = useDeferredValue(windowNow)
  const queryInput = useMemo(() => buildIngestionHealthInput({ now: deferredNow }), [deferredNow])

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setWindowNow(Date.now())
    }, OPERATIONAL_HEALTH_REFRESH_MS)

    return () => globalThis.clearInterval(intervalId)
  }, [])

  const { data, isFetching } = useSuspenseQuery(
    trpc.analytics.getIngestionStatus.queryOptions(queryInput, {
      staleTime: 15 * 1000,
      refetchOnWindowFocus: true,
    })
  )

  return (
    <IngestionHealthStrip
      status={data}
      isFetching={isFetching}
      title="Operational health"
      description="Ingestion health for the last hour. Rejections are business denials; failures need recovery."
    />
  )
}

export function OperationalHealthSkeleton() {
  return <Skeleton className="h-[250px] rounded-lg" />
}
