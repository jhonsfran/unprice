"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import { useParams } from "next/navigation"
import { SubmitButton } from "~/components/submit-button"
import { toBrowserAbsoluteUrl } from "~/lib/browser-url"
import { useTRPC } from "~/trpc/client"

export function PaymentMethodButton({
  customerId,
  successUrl,
  cancelUrl,
  paymentProvider,
  scope = "workspace",
  hasPaymentMethods,
  isRefreshing,
  onProviderSessionStarted,
}: {
  customerId: string
  successUrl: string
  cancelUrl: string
  paymentProvider: PaymentProvider
  scope?: "project" | "workspace"
  hasPaymentMethods?: boolean
  isRefreshing?: boolean
  onProviderSessionStarted?: () => void
}) {
  const trpc = useTRPC()
  const projectSlug = useParams().projectSlug as string | undefined
  const isSandbox = paymentProvider === "sandbox"

  const createSession = useMutation(
    (scope === "project"
      ? trpc.customers.createPaymentMethodByActiveProject
      : trpc.customers.createPaymentMethod
    ).mutationOptions({
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
          successUrl: toBrowserAbsoluteUrl(successUrl),
          cancelUrl: toBrowserAbsoluteUrl(cancelUrl),
          ...(scope === "project" && projectSlug ? { projectSlug } : {}),
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
