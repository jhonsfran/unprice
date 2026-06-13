import type { ChartConfig } from "@unprice/ui/chart"

export type UsageChartPoint = {
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

export { TIMESERIES_COLORS }

export function buildUsageChartConfig(features: string[]): ChartConfig {
  return Object.fromEntries(
    features.map((feature, index) => [
      feature,
      { label: feature, color: TIMESERIES_COLORS[index % TIMESERIES_COLORS.length] },
    ])
  ) satisfies ChartConfig
}
