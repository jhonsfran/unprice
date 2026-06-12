"use client"

import { nFormatter } from "@unprice/db/utils"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

type TimeseriesPoint = {
  date: number
  dateLabel: string
  [feature: string]: string | number
}

const TIMESERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

function formatUsage(value: number): string {
  return nFormatter(value, { digits: 1 })
}

export function CustomerUsageAreaChart({
  data,
  features,
  config,
}: {
  data: TimeseriesPoint[]
  features: string[]
  config: ChartConfig
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border p-4">
      <p className="mb-3 text-muted-foreground text-xs uppercase">Usage over time</p>
      <ChartContainer config={config} className="h-[240px] w-full">
        <AreaChart accessibilityLayer data={data} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} className="stroke-muted" />
          <XAxis
            dataKey="dateLabel"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(value) => formatUsage(Number(value))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value, name) => (
                  <>
                    <span>{String(name)}</span>
                    <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                      {formatUsage(Number(value))}
                    </span>
                  </>
                )}
              />
            }
          />
          {features.map((feature, i) => (
            <Area
              key={feature}
              type="monotone"
              dataKey={feature}
              stackId="usage"
              fill={TIMESERIES_COLORS[i % TIMESERIES_COLORS.length]}
              fillOpacity={0.15}
              stroke={TIMESERIES_COLORS[i % TIMESERIES_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
