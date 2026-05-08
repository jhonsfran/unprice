"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { nFormatter } from "@unprice/db/utils"
import { Button } from "@unprice/ui/button"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { BarChart4, Code } from "lucide-react"
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

const chartConfig = {
  usage: {
    label: "Usage",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig

export const UsageChartSkeleton = ({
  isLoading,
  error,
}: { isLoading?: boolean; error?: string }) => {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <EmptyPlaceholder className="min-h-[420px]" isLoading={isLoading}>
        <EmptyPlaceholder.Icon>
          <BarChart4 className="h-8 w-8" />
        </EmptyPlaceholder.Icon>
        <EmptyPlaceholder.Title>
          {error ? "Ups, something went wrong" : "No data available"}
        </EmptyPlaceholder.Title>
        <EmptyPlaceholder.Description>
          {error
            ? error
            : "There is no usage available for the selected interval. Start usage to see data."}
        </EmptyPlaceholder.Description>
        {!error && (
          <EmptyPlaceholder.Action>
            <CodeApiSheet defaultMethod="ingestUsage">
              <Button size={"sm"} disabled={isLoading}>
                <Code className="mr-2 h-4 w-4" />
                Start usage
              </Button>
            </CodeApiSheet>
          </EmptyPlaceholder.Action>
        )}
      </EmptyPlaceholder>
    </div>
  )
}

export function UsageChart() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const {
    data: usage,
    isLoading,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getUsage.queryOptions(
      {
        range: intervalFilter.name,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    )
  )

  // invalidate the query when the interval changes
  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsage"],
      {
        input: {
          range: param,
        },
        type: "query",
      },
    ],
  })

  if (isLoading || !usage || usage.usage.length === 0) {
    return <UsageChartSkeleton isLoading={isLoading} error={usage?.error} />
  }

  const chartData = usage.usage.map((v) => ({
    feature: v.feature_slug,
    usage: v.value_after,
  }))

  const maxHeight = 400
  const height = Math.min(chartData.length * 60, maxHeight) ?? 400

  return (
    <ChartContainer config={chartConfig} height={height} className="w-full">
      <BarChart
        accessibilityLayer
        data={chartData}
        layout="vertical"
        margin={{
          left: 0,
          right: 80,
          top: 10,
          bottom: 10,
        }}
        barGap={5}
        barCategoryGap={3}
      >
        <YAxis
          dataKey="feature"
          type="category"
          tickLine={false}
          tickMargin={10}
          width={120}
          axisLine={false}
          tickFormatter={(value) => (value?.length > 15 ? `${value.slice(0, 15)}...` : value)}
        />
        <XAxis dataKey="usage" type="number" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
        <Bar
          dataKey="usage"
          layout="vertical"
          radius={5}
          fill="var(--color-usage)"
          maxBarSize={25}
          activeBar={{
            opacity: 0.5,
          }}
          // TODO: onclick explore details of the feature on different page
          // onClick={(data) => console.info(data)}
        >
          <LabelList
            dataKey="usage"
            position="right"
            offset={8}
            className="fill-foreground"
            fontSize={12}
            formatter={(value: number) => nFormatter(value)}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
