import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { BarChart3 } from "lucide-react"
import { PaymentMethodButton } from "~/components/forms/payment-method-form"

type UsageRow = RouterOutputs["analytics"]["getUsage"]["usage"][number]

interface UsageDashboardProps {
  usageRows: UsageRow[]
  customerId: string
  workspaceSlug: string
}

function formatUsage(value: number): string {
  return nFormatter(value, { digits: 1 })
}

export function UsageDashboard({ usageRows, customerId, workspaceSlug }: UsageDashboardProps) {
  const sortedUsage = [...usageRows].sort((a, b) => {
    if (b.usage !== a.usage) {
      return b.usage - a.usage
    }

    return a.feature_slug.localeCompare(b.feature_slug)
  })

  const featureCount = sortedUsage.length
  const totalLatestUsage = sortedUsage.reduce((sum, row) => sum + row.usage, 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Usage & Billing</CardTitle>
            <CardDescription>
              Trusted analytics usage snapshot for the last 30 days.
            </CardDescription>
          </div>
          <PaymentMethodButton
            customerId={customerId}
            successUrl={`/${workspaceSlug}/settings/billing`}
            cancelUrl={`/${workspaceSlug}/settings/billing`}
            paymentProvider="stripe"
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
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
            <p className="text-muted-foreground text-sm">Data window</p>
            <p className="mt-1 font-semibold text-2xl text-foreground">30 days</p>
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
                key={`${row.project_id}:${row.customer_id ?? "all"}:${row.feature_slug}`}
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
