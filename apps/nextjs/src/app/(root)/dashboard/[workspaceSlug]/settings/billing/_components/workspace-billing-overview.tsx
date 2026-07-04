"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import type { Interval } from "@unprice/analytics"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { UsageDashboardView } from "~/components/analytics/usage-dashboard-view"
import { CurrentAccessOverview } from "~/components/billing/current-access-overview"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type WorkspaceBillingOverviewData = RouterOutputs["workspaces"]["getBillingOverview"]

export function WorkspaceBillingOverview({
  initialOverview,
  initialRange,
  workspaceSlug,
}: {
  initialOverview: WorkspaceBillingOverviewData
  initialRange: Interval
  workspaceSlug: string
}) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const queryInput = {
    workspaceSlug,
    range: intervalFilter.name,
  }

  const {
    data: overview,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.workspaces.getBillingOverview.queryOptions(queryInput, {
      ...ANALYTICS_CONFIG_REALTIME,
      ...(intervalFilter.name === initialRange ? { initialData: initialOverview } : {}),
      placeholderData: (previousData) => previousData,
    })
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["workspaces", "getBillingOverview"],
      {
        input: {
          workspaceSlug,
          range: param,
        },
        type: "query",
      },
    ],
  })

  return (
    <div className="flex flex-col gap-6">
      <CurrentAccessOverview
        access={overview.access}
        wallet={overview.wallet}
        description="Plan window and entitlement usage for this workspace."
        isFetching={isFetching}
        noActivePlanDescription="This workspace has no active subscription billing period."
        noActiveEntitlementsDescription="Access grants will appear here once the workspace has an active subscription phase."
      />
      <UsageDashboardView
        data={overview.usage}
        intervalLabel={intervalFilter.label}
        dateFormat={intervalFilter.dateFormat}
        mode="customer"
        isFetching={isFetching}
        showCustomerSummary={false}
        title="Workspace usage evidence"
        subjectLabel="workspace"
        showEmptyStateActions={false}
      />
    </div>
  )
}
