"use client"

import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts"
import { EmptyPlaceholder } from "~/components/empty-placeholder"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { BarChart4 } from "lucide-react"
import { useMemo } from "react"
import { useIntervalFilter, usePageFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { WEB_ANALYTICS_QUERY_CONFIG } from "~/trpc/shared"

const chartConfig = {
  browser: {
    label: "Browser",
    color: "var(--chart-1)",
  },
  visits: {
    label: "Visits",
    color: "var(--chart-1)",
  },
  hits: {
    label: "Hits",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

export function BrowsersSkeleton({
  isLoading,
  error,
}: {
  isLoading?: boolean
  error?: string
}) {
  const [intervalFilter] = useIntervalFilter()
  const [pageFilter] = usePageFilter()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser vistis</CardTitle>
        <CardDescription>All browser visits for the {intervalFilter.label}</CardDescription>
      </CardHeader>
      <CardContent>
        <EmptyPlaceholder className="min-h-[250px]" isLoading={isLoading}>
          <EmptyPlaceholder.Icon>
            <BarChart4 className="h-8 w-8" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>
            {error
              ? "Ups, something went wrong"
              : !pageFilter.isSelected
                ? "No page selected"
                : "No data available"}
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            {error
              ? error
              : !pageFilter.isSelected
                ? "Please select a page to see browser visits."
                : `There is no browser visits available for the ${intervalFilter.label}.`}
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

export function Browsers() {
  const [intervalFilter] = useIntervalFilter()
  const [pageFilter] = usePageFilter()

  const trpc = useTRPC()
  const { data, isLoading, isFetching, dataUpdatedAt } = useSuspenseQuery(
    trpc.analytics.getBrowserVisits.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
        page_id: pageFilter.pageId,
      },
      {
        enabled: pageFilter.isSelected,
        ...WEB_ANALYTICS_QUERY_CONFIG,
      }
    )
  )

  // invalidate the query when the interval changes
  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getBrowserVisits"],
      {
        input: {
          interval_days: param,
          page_id: pageFilter.pageId,
        },
        type: "query",
      },
    ],
  })

  // group by browser using useMemo having something like an array of { browser: "Chrome", visits: 214, hits: 140 }
  // there are multiple items with the same browser that we need to sum the visits and hits
  // we need to return an array of { browser: "Chrome", visits: 214, hits: 140 }
  const groupedData = useMemo(() => {
    return data.data.reduce(
      (acc, curr) => {
        const existingItem = acc.find((item) => item.browser === curr.browser)
        if (existingItem) {
          existingItem.visits += curr.visits
          existingItem.hits += curr.hits
        } else {
          acc.push({
            browser: curr.browser,
            visits: curr.visits,
            hits: curr.hits,
          })
        }
        return acc
      },
      [] as { browser: string; visits: number; hits: number }[]
    )
  }, [pageFilter.pageId, intervalFilter.intervalDays, data.data.length])

  if (isLoading || !groupedData || groupedData.length === 0) {
    return <BrowsersSkeleton isLoading={isLoading} error={data.error} />
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser vistis</CardTitle>
        <CardDescription>All browser visits for the {intervalFilter.label}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig}>
          <BarChart
            accessibilityLayer
            data={groupedData}
            layout="vertical"
            margin={{
              right: 40,
              top: 0,
            }}
            barGap={5}
            barCategoryGap={3}
          >
            <YAxis
              dataKey="browser"
              type="category"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
              width={120}
              tickFormatter={(value) => value.slice(0, 3)}
              hide
            />
            <XAxis dataKey="visits" type="number" hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Bar
              dataKey="visits"
              layout="vertical"
              fill="var(--color-visits)"
              radius={5}
              maxBarSize={30}
              activeBar={{
                opacity: 0.5,
              }}
            >
              <LabelList
                dataKey="browser"
                position="insideLeft"
                offset={8}
                className="fill-background-textContrast font-semibold text-background-textContrast"
                fontSize={12}
              />
              <LabelList
                dataKey="visits"
                position="right"
                offset={8}
                className="fill-background-textContrast font-semibold text-background-textContrast"
                fontSize={12}
                formatter={(value: number) => nFormatter(value)}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
