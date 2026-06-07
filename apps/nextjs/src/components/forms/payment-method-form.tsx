"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import { SubmitButton } from "~/components/submit-button"
import { useTRPC } from "~/trpc/client"

export function PaymentMethodButton({
  customerId,
  successUrl,
  cancelUrl,
  paymentProvider,
  hasPaymentMethods,
  isRefreshing,
  onProviderSessionStarted,
}: {
  customerId: string
  successUrl: string
  cancelUrl: string
  paymentProvider: PaymentProvider
  hasPaymentMethods?: boolean
  isRefreshing?: boolean
  onProviderSessionStarted?: () => void
}) {
  const trpc = useTRPC()
  const isSandbox = paymentProvider === "sandbox"

  const createSession = useMutation(
    trpc.customers.createPaymentMethod.mutationOptions({
      onSuccess: (data) => {
        if (!data?.url) return

        onProviderSessionStarted?.()

        // Keep the subscription draft open while the provider flow runs separately.
        const providerWindow = window.open(data.url, "_blank")
        if (!providerWindow) {
          window.location.assign(data.url)
        }
      },
    })
  )

  return (
    <SubmitButton
      variant="default"
      size="sm"
      className="w-56"
      onClick={() => {
        if (isSandbox) {
          onProviderSessionStarted?.()
          return
        }

        createSession.mutate({
          paymentProvider: paymentProvider,
          customerId,
          successUrl,
          cancelUrl,
        })
      }}
      isSubmitting={!isSandbox && createSession.isPending}
      isDisabled={!customerId || (!isSandbox && createSession.isPending) || isRefreshing}
      isLoading={!isSandbox && createSession.isPending}
      label={
        hasPaymentMethods
          ? "Billing Portal"
          : isSandbox
            ? "Use Sandbox Method"
            : "Add Payment Method"
      }
    />
  )
}
