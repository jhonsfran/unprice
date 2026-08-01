import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { CopyButton } from "~/components/copy-button"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { api } from "~/trpc/server"
import { SubscriptionCancelButton } from "../../_components/subscriptions/subscription-cancel-button"
import { SubscriptionForm } from "../../_components/subscriptions/subscription-form"

function SubscriptionFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-xs tabular-nums">{value}</dd>
    </div>
  )
}

export default async function SubscriptionPage(props: {
  params: Promise<{
    workspaceSlug: string
    projectSlug: string
    subscriptionId: string
  }>
}) {
  const params = await props.params
  const { workspaceSlug, projectSlug } = params
  const { subscription } = await api.subscriptions.getById({
    id: params.subscriptionId,
  })

  if (!subscription) {
    notFound()
  }

  const customer = await api.customers
    .getById({ id: subscription.customerId })
    .then((result) => result.customer)
    .catch(() => null)
  const customerBaseUrl = `/${workspaceSlug}/${projectSlug}/customers/${subscription.customerId}`
  const cycleLabel = `${formatDate(
    subscription.currentCycleStartAt,
    subscription.timezone,
    "MMM dd, yyyy"
  )} – ${formatDate(subscription.currentCycleEndAt, subscription.timezone, "MMM dd, yyyy")}`
  const renewsLabel = subscription.renewAt
    ? formatDate(subscription.renewAt, subscription.timezone, "MMM dd, yyyy")
    : "Not scheduled"

  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <Card variant="ghost" className="w-full p-0">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="flex items-center justify-between font-primary font-semibold text-2xl text-foreground tracking-tight">
              <span className="flex items-center gap-3">
                Subscription
                {subscription.status === "active" ? (
                  <span className="flex items-center gap-1.5 font-normal font-secondary text-muted-foreground text-xs">
                    <span className="size-1.5 rounded-full bg-success-solid" aria-hidden="true" />
                    Active
                  </span>
                ) : (
                  <Badge variant={subscription.active ? "success" : "destructive"}>
                    {subscription.status}
                  </Badge>
                )}
                <CopyButton value={subscription.id} className="size-4" />
              </span>
              <span className="flex items-center gap-2">
                <CodeApiSheet defaultMethod="getSubscription">
                  <Button variant={"link"}>
                    <Code className="mr-2 h-4 w-4" />
                    API
                  </Button>
                </CodeApiSheet>
                {subscription.active && (
                  <SubscriptionCancelButton subscriptionId={subscription.id} />
                )}
              </span>
            </CardTitle>
            <CardDescription>
              The money state for this subscription: who is billed, on which plan, and the phases
              that govern each billing period.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex w-full flex-col gap-6 px-0 py-4">
            {/* evidence first: the subscription facts read like a receipt,
                with the durable identifiers one click away */}
            <div className="rounded-md border">
              <dl className="grid gap-x-10 gap-y-3 px-4 py-4 sm:grid-cols-2">
                <SubscriptionFact
                  label="Customer"
                  value={
                    <SuperLink
                      href={customerBaseUrl}
                      className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      {customer?.name || customer?.email || subscription.customerId}
                    </SuperLink>
                  }
                />
                <SubscriptionFact label="Plan" value={subscription.planSlug} />
                <SubscriptionFact label="Current cycle" value={cycleLabel} />
                <SubscriptionFact label="Renews" value={renewsLabel} />
                <SubscriptionFact label="Timezone" value={subscription.timezone} />
                <SubscriptionFact
                  label="Invoices"
                  value={
                    <SuperLink
                      href={`${customerBaseUrl}/invoices`}
                      className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      View invoice evidence
                    </SuperLink>
                  }
                />
              </dl>
            </div>

            {/* the form holds phases in client state; keying it on the server
                snapshot re-initializes it after phase mutations refresh the
                page, so new phases appear without a manual reload */}
            <SubscriptionForm
              key={`${subscription.id}:${subscription.phases
                .map((phase) => `${phase.id}.${phase.updatedAtM ?? 0}`)
                .join("|")}`}
              defaultValues={subscription}
            />
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
