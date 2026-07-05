"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import type { ButtonProps } from "@unprice/ui/button"
import { useParams } from "next/navigation"
import { SubmitButton } from "~/components/submit-button"
import { toBrowserAbsoluteUrl } from "~/lib/browser-url"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

type BasePaymentMethodButtonProps = {
  customerId: string
  successUrl: string
  cancelUrl: string
  size?: ButtonProps["size"]
  paymentProvider: PaymentProvider
  hasPaymentMethods?: boolean
  isRefreshing?: boolean
  isDisabled?: boolean
  variant?: ButtonProps["variant"]
  onProviderSessionStarted?: () => void
}

type WorkspacePaymentMethodButtonProps = BasePaymentMethodButtonProps & {
  scope?: "workspace"
  workspaceSlug: string
}

type ProjectPaymentMethodButtonProps = BasePaymentMethodButtonProps & {
  scope: "project"
  workspaceSlug?: never
}

type PaymentMethodButtonProps = WorkspacePaymentMethodButtonProps | ProjectPaymentMethodButtonProps

export function PaymentMethodButton(props: PaymentMethodButtonProps) {
  const {
    customerId,
    successUrl,
    cancelUrl,
    size,
    paymentProvider,
    hasPaymentMethods,
    isRefreshing,
    isDisabled,
    variant,
    onProviderSessionStarted,
  } = props
  const trpc = useTRPC()
  const params = useParams()
  const projectSlug = params.projectSlug as string | undefined
  const isWorkspaceScope = props.scope !== "project"
  const isSandbox = paymentProvider === "sandbox"

  const handleProviderSessionStarted = (data?: { url: string }) => {
    if (!data?.url) return

    onProviderSessionStarted?.()

    // Keep the subscription draft open while the provider flow runs separately.
    const providerWindow = window.open(data.url, "_blank")
    if (!providerWindow) {
      window.location.assign(data.url)
    }
  }

  const createWorkspaceSession = useMutation(
    trpc.customers.createPaymentMethod.mutationOptions({
      onSuccess: handleProviderSessionStarted,
    })
  )
  const createProjectSession = useMutation(
    trpc.customers.createPaymentMethodByActiveProject.mutationOptions({
      onSuccess: handleProviderSessionStarted,
    })
  )
  const createSessionPending = isWorkspaceScope
    ? createWorkspaceSession.isPending
    : createProjectSession.isPending

  return (
    <SubmitButton
      variant={variant ?? "default"}
      size={size ?? "sm"}
      onClick={() => {
        if (isDisabled) return

        if (isSandbox) {
          toast.info("Sandbox payment provider", {
            description:
              "This customer uses the sandbox provider, so there is no external billing portal.",
          })
          onProviderSessionStarted?.()
          return
        }

        const basePayload = {
          paymentProvider: paymentProvider,
          customerId,
          successUrl: toBrowserAbsoluteUrl(successUrl),
          cancelUrl: toBrowserAbsoluteUrl(cancelUrl),
        }

        if (isWorkspaceScope) {
          createWorkspaceSession.mutate({
            ...basePayload,
            workspaceSlug: props.workspaceSlug,
          })
          return
        }

        createProjectSession.mutate({
          ...basePayload,
          ...(projectSlug ? { projectSlug } : {}),
        })
      }}
      isSubmitting={!isSandbox && createSessionPending}
      isDisabled={isDisabled || !customerId || (!isSandbox && createSessionPending) || isRefreshing}
      isLoading={!isSandbox && createSessionPending}
      label={
        isSandbox
          ? hasPaymentMethods
            ? "Sandbox Provider"
            : "Use Sandbox Method"
          : hasPaymentMethods
            ? "Billing Portal"
            : "Add Payment Method"
      }
    />
  )
}
