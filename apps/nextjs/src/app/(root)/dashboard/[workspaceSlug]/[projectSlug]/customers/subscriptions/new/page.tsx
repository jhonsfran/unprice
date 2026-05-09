import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SubscriptionForm } from "../../_components/subscriptions/subscription-form"

export default async function NewSubscriptionPage({
  searchParams,
}: {
  searchParams: {
    customerId?: string
  }
}) {
  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <Card variant="ghost" className="w-full">
          <CardHeader>
            <CardTitle>Create Subscription</CardTitle>
            <CardDescription>Configure the subscription for the selected customer.</CardDescription>
          </CardHeader>
          <CardContent className="py-4">
            <SubscriptionForm
              defaultValues={{
                customerId: searchParams.customerId ?? "",
                phases: [],
                timezone: "UTC",
              }}
            />
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
