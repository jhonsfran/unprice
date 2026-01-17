import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { SubscriptionForm } from "../../_components/subscriptions/subscription-form"

export default async function EditSubscriptionPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    subscriptionId: string
  }
}) {
  const { subscription } = await api.subscriptions.getById({
    id: params.subscriptionId,
  })

  if (!subscription) {
    notFound()
  }

  return (
    <DashboardShell>
      <div className="flex flex-col items-center justify-center">
        <Card variant="ghost" className="w-full p-0">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="flex items-center justify-between font-primary font-semibold text-2xl text-foreground tracking-tight">
              Edit Subscription
              <CodeApiSheet defaultMethod="getSubscription">
                <Button variant={"outline"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
            </CardTitle>
            <CardDescription>Edit the subscription.</CardDescription>
          </CardHeader>
          <CardContent className="w-full px-0 py-4">
            <SubscriptionForm defaultValues={subscription} />
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
