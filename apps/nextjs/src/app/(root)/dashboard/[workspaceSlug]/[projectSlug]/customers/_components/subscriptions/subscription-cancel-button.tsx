"use client"

import { useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { toast } from "@unprice/ui/sonner"
import { useParams } from "next/navigation"
import { startTransition } from "react"
import { revalidateAppPath } from "~/actions/revalidate"
import { ConfirmAction } from "~/components/confirm-action"
import { useTRPC } from "~/trpc/client"

export const SubscriptionCancelButton = ({
  onConfirmAction,
  subscriptionId,
  variant = "destructive",
}: {
  onConfirmAction?: () => void
  subscriptionId: string
  variant?: "destructive" | "secondary"
}) => {
  const trpc = useTRPC()
  const workspaceSlug = useParams().workspaceSlug as string

  const cancelSubscription = useMutation(
    trpc.subscriptions.cancel.mutationOptions({
      onSuccess: async () => {
        await revalidateAppPath(`/dashboard/${workspaceSlug}/settings/billing`, "page")
      },
    })
  )

  function onCancelSubscription() {
    startTransition(() => {
      toast.promise(
        cancelSubscription.mutateAsync({
          id: subscriptionId,
          endAt: Date.now(),
          metadata: null,
        }),
        {
          loading: "Cancelling subscription...",
          success: "Subscription cancelled",
        }
      )
    })
  }

  return (
    <ConfirmAction
      message="This cancels the subscription immediately. Future phases will not renew or create new invoices. Create a new phase instead if you want to change the plan. Are you sure you want to cancel this subscription?"
      confirmAction={() => {
        onConfirmAction?.()
        onCancelSubscription()
      }}
    >
      <Button variant={variant} disabled={cancelSubscription.isPending}>
        Cancel subscription
        {cancelSubscription.isPending && <LoadingAnimation className={"ml-2"} />}
      </Button>
    </ConfirmAction>
  )
}
