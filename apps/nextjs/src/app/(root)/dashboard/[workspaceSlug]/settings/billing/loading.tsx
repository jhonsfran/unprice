import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { PaymentMethodButton } from "~/components/forms/payment-method-form"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default function BillingPageLoading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Workspace usage evidence"
          description="Usage, billing, and invoice activity reported for this workspace."
        />
      }
    >
      <SubscriptionCardLoading />
      <PaymentMethodCardLoading />
      <UsageCardLoading />
    </DashboardShell>
  )
}

function SubscriptionCardLoading() {
  return (
    <Card className="animate-pulse">
      <CardHeader>
        <CardTitle>Subscription Info</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="h-6 w-3/4 rounded bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-1/2 rounded bg-muted" />
            <div className="h-4 w-2/3 rounded bg-muted" />
          </div>
          <div className="h-20 rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  )
}

function PaymentMethodCardLoading() {
  return (
    <Card className="mt-4 animate-pulse">
      <CardHeader>
        <CardTitle>Default Payment Method</CardTitle>
      </CardHeader>
      <CardContent>
        <PaymentMethodButton
          customerId="customer_id"
          successUrl={""}
          cancelUrl={""}
          paymentProvider="stripe"
        />
      </CardContent>
    </Card>
  )
}

function UsageCardLoading() {
  return (
    <Card className="mt-4 animate-pulse">
      <CardHeader>
        <CardTitle>Subscription usage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="h-4 w-1/2 rounded bg-muted" />
          <div className="h-20 rounded bg-muted" />
        </div>
      </CardContent>
      <CardFooter>
        <Button disabled className="w-full">
          <Skeleton className="h-4 w-24" />
        </Button>
      </CardFooter>
    </Card>
  )
}
