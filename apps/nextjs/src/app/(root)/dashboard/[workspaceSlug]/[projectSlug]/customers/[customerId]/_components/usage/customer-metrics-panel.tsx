import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { BarChart3 } from "lucide-react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"

type UsageRow = RouterOutputs["analytics"]["getUsage"]["usage"][number]

type CustomerMetricsPanelProps = {
  usageRows: UsageRow[]
  error?: string
}

function formatUsage(value: number): string {
  return nFormatter(value, { digits: 1 })
}

export function CustomerMetricsPanel(props: CustomerMetricsPanelProps) {
  const { usageRows, error } = props

  const sortedUsage = [...usageRows].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }
    return a.feature_slug.localeCompare(b.feature_slug)
  })

  const featureCount = sortedUsage.length
  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)
  const topFeature = sortedUsage[0]?.feature_slug ?? "—"
  const topFeatureUsage = sortedUsage[0]?.usage ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer Metrics</CardTitle>
        <CardDescription>
          Usage snapshot from <code>getUsage</code> over the last 30 days.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {error && <p className="text-destructive text-sm">{error}</p>}

        {sortedUsage.length === 0 ? (
          <EmptyPlaceholder className="h-[220px] w-auto border border-dashed">
            <EmptyPlaceholder.Icon>
              <BarChart3 className="h-8 w-8 opacity-30" />
            </EmptyPlaceholder.Icon>
            <EmptyPlaceholder.Title>No usage metrics yet</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              No usage data was reported for this customer in the selected window.
            </EmptyPlaceholder.Description>
          </EmptyPlaceholder>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-muted-foreground text-sm">Features with usage</p>
                <p className="mt-1 font-semibold text-2xl text-foreground">{featureCount}</p>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-muted-foreground text-sm">Total latest usage</p>
                <p className="mt-1 font-semibold text-2xl text-foreground">
                  {formatUsage(totalLatestUsage)}
                </p>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-muted-foreground text-sm">Top feature</p>
                <p className="mt-1 truncate font-semibold text-foreground text-xl">{topFeature}</p>
                <p className="text-muted-foreground text-xs">{formatUsage(topFeatureUsage)} used</p>
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
                    key={`${row.project_id}:${row.customer_id ?? "customer"}:${row.feature_slug}`}
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
          </>
        )}
      </CardContent>
    </Card>
  )
}
