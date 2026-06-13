"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { useParams } from "next/navigation"
import {
  UsageDashboardSkeleton,
  UsageDashboardView,
} from "~/components/analytics/usage-dashboard-view"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

export { UsageDashboardSkeleton as UsageStatsSkeleton }

export function UsageStats() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const { data, dataUpdatedAt, isFetching } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(
      {
        range: intervalFilter.name,
        topConsumersLimit: 10,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 30 * 1000 : 0,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsageDashboard"],
      {
        input: {
          range: param,
          topConsumersLimit: 10,
        },
        type: "query",
      },
    ],
  })

  return (
    <UsageDashboardView
      data={data}
      intervalLabel={intervalFilter.label}
      dateFormat={intervalFilter.dateFormat}
      mode="project"
      isFetching={isFetching}
      customerHref={(customerId) =>
        `/${params.workspaceSlug}/${params.projectSlug}/customers/${customerId}`
      }
    />
  )
}
