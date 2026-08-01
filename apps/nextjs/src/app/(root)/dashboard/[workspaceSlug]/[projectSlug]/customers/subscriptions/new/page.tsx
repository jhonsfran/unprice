import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { SubscriptionForm } from "../../_components/subscriptions/subscription-form"

export default async function NewSubscriptionPage(props: {
  searchParams: Promise<{
    customerId?: string
  }>
}) {
  const searchParams = await props.searchParams
  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <Card variant="ghost" className="w-full">
          <CardHeader>
            <CardTitle>Create subscription</CardTitle>
            <CardDescription>
              Assign a customer to a plan version, billing period, wallet policy, and invoice
              evidence path.
            </CardDescription>
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
