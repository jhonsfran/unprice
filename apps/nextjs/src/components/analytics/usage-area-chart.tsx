"use client"

import { nFormatter } from "@unprice/db/utils"
import type { ChartConfig } from "@unprice/ui/chart"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@unprice/ui/chart"
import { cn } from "@unprice/ui/utils"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { TIMESERIES_COLORS, type UsageChartPoint } from "./usage-chart-config"

export function UsageAreaChart({
  data,
  features,
  config,
  className,
  heightClassName = "h-[220px]",
}: {
  data: UsageChartPoint[]
  features: string[]
  config: ChartConfig
  className?: string
  heightClassName?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border/60 p-3 sm:p-4", className)}>
      <p className="mb-3 text-muted-foreground text-xs uppercase">Usage over time</p>
      <ChartContainer config={config} className={cn(heightClassName, "w-full")}>
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
            tickFormatter={(value) => nFormatter(Number(value), { digits: 1 })}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value, name) => (
                  <>
                    <span>{String(name)}</span>
                    <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                      {nFormatter(Number(value), { digits: 1 })}
                    </span>
                  </>
                )}
              />
            }
          />
          {features.map((feature, index) => (
            <Area
              key={feature}
              type="monotone"
              dataKey={feature}
              stackId="usage"
              fill={TIMESERIES_COLORS[index % TIMESERIES_COLORS.length]}
              fillOpacity={0.15}
              stroke={TIMESERIES_COLORS[index % TIMESERIES_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
