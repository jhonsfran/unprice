"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import {
  UsageDashboardSkeleton,
  UsageDashboardView,
} from "~/components/analytics/usage-dashboard-view"
import type { SDKExampleParams } from "~/components/sdk-snippets/sdk-examples"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
  currentAccess: RouterOutputs["customers"]["getCurrentAccess"]
}

export function CustomerMetricsPanelSkeleton() {
  return (
    <UsageDashboardSkeleton
      mode="customer"
      display={{
        showCustomerSummary: false,
        showHeaderControls: false,
      }}
    />
  )
}

export function CustomerMetricsPanel({ customerId, currentAccess }: CustomerMetricsPanelProps) {
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
      usageExampleParams={buildCustomerUsageExampleParams(customerId, currentAccess)}
      display={{
        showCustomerSummary: false,
        showHeaderControls: false,
      }}
    />
  )
}

function buildCustomerUsageExampleParams(
  customerId: string,
  currentAccess: RouterOutputs["customers"]["getCurrentAccess"]
): SDKExampleParams {
  const usageEntitlement = currentAccess.entitlements.find((entitlement) => entitlement.meterConfig)

  if (!usageEntitlement?.meterConfig) {
    return { customerId }
  }

  return {
    customerId,
    usage: {
      featureSlug: usageEntitlement.featureSlug,
      eventSlug: usageEntitlement.meterConfig.eventSlug,
      aggregationMethod: usageEntitlement.meterConfig.aggregationMethod,
      aggregationField: usageEntitlement.meterConfig.aggregationField,
    },
  }
}
