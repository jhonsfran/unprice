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

export function UsageAreaChart({
  data,
  features,
  config,
}: {
  data: TimeseriesPoint[]
  features: string[]
  config: ChartConfig
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60 p-3 sm:p-4">
      <p className="mb-3 text-muted-foreground text-xs uppercase">Usage over time</p>
      <ChartContainer config={config} className="h-[200px] w-full">
        <AreaChart accessibilityLayer data={data} margin={{ left: 8, right: 8, top: 6, bottom: 6 }}>
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
            tickFormatter={(value) => nFormatter(Number(value))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value, name) => (
                  <>
                    <span>{String(name)}</span>
                    <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                      {nFormatter(Number(value))}
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
