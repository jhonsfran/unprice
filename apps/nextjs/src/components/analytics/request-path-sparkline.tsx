"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import type { IngestionStatus } from "./ingestion-health-model"

const chartConfig = {
  processed: { label: "Processed", color: "var(--chart-1)" },
  rejected: { label: "Rejected", color: "var(--chart-3)" },
  failed: { label: "Failed", color: "var(--chart-5)" },
} satisfies ChartConfig

export function RequestPathSparkline({ live }: { live: IngestionStatus["live"] }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Request path</CardTitle>
        <CardDescription>
          Processed, rejected, and failed ingestion events by second.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        {live.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
            No live ingestion samples in this window.
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[220px] w-full">
            <LineChart
              accessibilityLayer
              data={live}
              margin={{ left: 8, right: 8, top: 8, bottom: 8 }}
            >
              <CartesianGrid vertical={false} className="stroke-muted" />
              <XAxis
                dataKey="second"
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
              />
              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
              <Line
                type="monotone"
                dataKey="processed"
                stroke="var(--color-processed)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="rejected"
                stroke="var(--color-rejected)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="failed"
                stroke="var(--color-failed)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
