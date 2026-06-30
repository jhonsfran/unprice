"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import type { ChartConfig } from "@unprice/ui/chart"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { format } from "date-fns"
import { Suspense, lazy } from "react"
import { EvidenceFrame, EvidenceSection } from "./evidence-panel"
import type { IngestionStatus } from "./ingestion-health-model"

const chartConfig = {
  processed: { label: "Processed", color: "var(--chart-1)" },
  rejected: { label: "Rejected", color: "var(--chart-3)" },
  failed: { label: "Failed", color: "var(--chart-5)" },
} satisfies ChartConfig

type RequestPathChartProps = {
  live: IngestionStatus["live"]
  window: IngestionStatus["window"]
  framed?: boolean
}

const LazyRequestPathChartContent = lazy(async () => {
  const [{ ChartContainer, ChartTooltip, ChartTooltipContent }, Recharts] = await Promise.all([
    import("@unprice/ui/chart"),
    import("recharts"),
  ])
  const { CartesianGrid, Line, LineChart, XAxis, YAxis } = Recharts

  function RequestPathChartContent({ live, window, framed = false }: RequestPathChartProps) {
    const chart = (
      <ChartContainer
        config={chartConfig}
        className={cn(framed ? "h-full" : "h-[220px]", "w-full")}
      >
        <LineChart accessibilityLayer data={live} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} className="stroke-muted" />
          <XAxis
            dataKey="second"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            minTickGap={36}
            tickFormatter={(value) => formatRequestPathTick(value, window)}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(value) => formatRequestPathTooltip(value)}
              />
            }
          />
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
    )

    if (!framed) {
      return chart
    }

    return <EvidenceFrame className="px-2 py-3">{chart}</EvidenceFrame>
  }

  return { default: RequestPathChartContent }
})

export function RequestPathSparkline({
  live,
  window,
  presentation = "card",
  className,
}: {
  live: IngestionStatus["live"]
  window: IngestionStatus["window"]
  presentation?: "card" | "section"
  className?: string
}) {
  if (presentation === "section") {
    return (
      <EvidenceSection
        title="Request path"
        description="Processed, rejected, and failed ingestion events by second."
        className={className}
        contentClassName="mt-3"
        titleClassName="text-base"
      >
        <RequestPathChart live={live} window={window} framed />
      </EvidenceSection>
    )
  }

  return (
    <Card className={cn("border-muted/60", className)}>
      <CardHeader>
        <CardTitle>Request path</CardTitle>
        <CardDescription>
          Processed, rejected, and failed ingestion events by second.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <RequestPathChart live={live} window={window} />
      </CardContent>
    </Card>
  )
}

function RequestPathChart({ live, window, framed = false }: RequestPathChartProps) {
  if (live.length === 0) {
    return (
      <EvidenceFrame
        variant={framed ? "dashed" : "solid"}
        className={cn(
          "flex items-center justify-center text-muted-foreground text-sm",
          !framed && "border-dashed bg-transparent"
        )}
      >
        No live ingestion samples in this window.
      </EvidenceFrame>
    )
  }

  return (
    <Suspense fallback={<RequestPathChartFallback framed={framed} />}>
      <LazyRequestPathChartContent live={live} window={window} framed={framed} />
    </Suspense>
  )
}

function RequestPathChartFallback({ framed }: { framed: boolean }) {
  if (!framed) {
    return <Skeleton className="h-[220px] w-full rounded-md" />
  }

  return (
    <EvidenceFrame className="px-2 py-3">
      <Skeleton className="h-full w-full rounded-none" />
    </EvidenceFrame>
  )
}

function formatRequestPathTick(value: unknown, window: IngestionStatus["window"]): string {
  const date = parseChartDate(value)
  if (!date) {
    return String(value)
  }

  const windowMs = window.to - window.from
  if (windowMs <= 24 * 60 * 60 * 1000) {
    return format(date, "HH:mm")
  }

  if (windowMs <= 31 * 24 * 60 * 60 * 1000) {
    return format(date, "MMM d")
  }

  return format(date, "MMM yyyy")
}

function formatRequestPathTooltip(value: unknown): string {
  const date = parseChartDate(value)
  return date ? format(date, "MMM d, yyyy HH:mm:ss") : String(value)
}

function parseChartDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null
  }

  const rawValue = String(value)
  const parsedValue = Date.parse(
    rawValue.includes("T") ? rawValue : `${rawValue.replace(" ", "T")}Z`
  )

  if (!Number.isFinite(parsedValue)) {
    return null
  }

  return new Date(parsedValue)
}
