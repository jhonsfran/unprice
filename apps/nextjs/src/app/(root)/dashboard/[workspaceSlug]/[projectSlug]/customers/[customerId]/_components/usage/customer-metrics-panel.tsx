"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { BarChart3, CalendarRange, Layers3, TriangleAlert } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
}

function formatUsage(value: number): string {
  return nFormatter(value, { digits: 1 })
}

export function CustomerMetricsPanelSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Loading customer usage metrics...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          {["features", "usage", "interval"].map((item) => (
            <div key={`customer-usage-skeleton-${item}`} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-[220px] w-full" />
      </CardContent>
    </Card>
  )
}

function CustomerMetricsErrorState({ error }: { error: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="h-[220px] w-auto border border-dashed">
          <EmptyPlaceholder.Icon>
            <TriangleAlert className="h-8 w-8 opacity-60" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Unable to load usage</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error}</EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function CustomerMetricsEmptyState({ intervalLabel }: { intervalLabel: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage for this customer in the {intervalLabel}.</CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="h-[220px] w-auto border border-dashed">
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8 opacity-30" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No usage metrics yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            No usage data was reported for this customer in the selected window.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function CustomerMetricsPanel({ customerId }: CustomerMetricsPanelProps) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const {
    data: usage,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getProjectUsage.queryOptions(
      {
        customerId,
        range: intervalFilter.name,
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
      ["analytics", "getProjectUsage"],
      {
        input: {
          customerId,
          range: param,
        },
        type: "query",
      },
    ],
  })

  if (usage.error) {
    return <CustomerMetricsErrorState error={usage.error} />
  }

  const sortedUsage = [...usage.usage].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }

    return a.feature_slug.localeCompare(b.feature_slug)
  })

  if (sortedUsage.length === 0) {
    return <CustomerMetricsEmptyState intervalLabel={intervalFilter.label} />
  }

  const featureCount = sortedUsage.length
  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer usage</CardTitle>
        <CardDescription>Usage for this customer in the {intervalFilter.label}.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Features with usage</p>
              <Layers3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-2xl text-foreground">{featureCount}</p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Total latest usage</p>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-2xl text-foreground">
              {formatUsage(totalLatestUsage)}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">Selected interval</p>
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-1 font-semibold text-foreground text-xl capitalize">
              {intervalFilter.label}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center bg-muted/40 px-4 py-2.5">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Feature</p>
            <p className="text-right text-muted-foreground text-xs uppercase tracking-wide">
              Usage
            </p>
          </div>

          <div className="divide-y divide-border">
            {sortedUsage.map((row) => (
              <div
                key={`${row.project_id}:${row.customer_id ?? customerId}:${row.feature_slug}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{row.feature_slug}</span>
                </div>
                <Badge variant="outline" className="justify-self-end font-mono text-xs">
                  {formatUsage(row.usage)}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
