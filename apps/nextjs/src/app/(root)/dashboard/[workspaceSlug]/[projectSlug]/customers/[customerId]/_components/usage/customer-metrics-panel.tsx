"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import {
  UsageDashboardSkeleton,
  UsageDashboardView,
} from "~/components/analytics/usage-dashboard-view"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
  invoiceCount: number
}

export { UsageDashboardSkeleton as CustomerMetricsPanelSkeleton }

export function CustomerMetricsPanel({ customerId, invoiceCount }: CustomerMetricsPanelProps) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const queryInput = {
    customerId,
    range: intervalFilter.name,
  }

  const { data, dataUpdatedAt, isFetching } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(queryInput, {
      ...ANALYTICS_CONFIG_REALTIME,
      placeholderData: (previousData) => previousData,
    })
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsageDashboard"],
      {
        input: {
          customerId,
          range: param,
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
      mode="customer"
      isFetching={isFetching}
      invoiceCount={invoiceCount}
    />
  )
}
