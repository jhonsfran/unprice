"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider, PaymentProviderConfig } from "@unprice/db/validators"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Switch } from "@unprice/ui/switch"
import { cn } from "@unprice/ui/utils"
import { CreditCard, ExternalLink, RefreshCw, TestTube2, TriangleAlert } from "lucide-react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

type ProviderUiStatus = "ready" | "needs_onboarding" | "restricted" | "disabled" | "sandbox"

type StripeConnectionIssue = {
  title: string
  description: string
  fields: string[]
}

const STATUS_META: Record<
  ProviderUiStatus,
  {
    label: string
    variant: "default" | "secondary" | "destructive" | "outline" | "info" | "success" | "warning"
  }
> = {
  ready: { label: "Ready", variant: "success" },
  needs_onboarding: { label: "Needs onboarding", variant: "warning" },
  restricted: { label: "Needs action", variant: "warning" },
  disabled: { label: "Disabled", variant: "destructive" },
  sandbox: { label: "Sandbox", variant: "info" },
}

const STRIPE_REQUIREMENT_LABELS: Record<string, string> = {
  "individual.address.city": "Legal address",
  "individual.address.line1": "Legal address",
  "individual.address.postal_code": "Legal address",
  "individual.dob.day": "Date of birth",
  "individual.dob.month": "Date of birth",
  "individual.dob.year": "Date of birth",
  "individual.first_name": "Legal first name",
  "individual.last_name": "Legal last name",
  "individual.phone": "Phone number",
  "individual.verification.additional_document": "Additional identity document",
  "individual.verification.document": "Identity document",
  "individual.verification.proof_of_liveness": "Proof of liveness",
}

function formatStripeRequirement(requirement: string): string {
  const knownLabel = STRIPE_REQUIREMENT_LABELS[requirement]

  if (knownLabel) {
    return knownLabel
  }

  return requirement
    .split(".")
    .filter(Boolean)
    .map((part) => part.replaceAll("_", " "))
    .join(" ")
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

function formatStripeDisabledReason(disabledReason?: string | null): string | null {
  if (!disabledReason) {
    return null
  }

  if (disabledReason === "requirements.past_due") {
    return "Stripe disabled this account because required verification details are past due."
  }

  return `Stripe disabled this account: ${formatStripeRequirement(disabledReason)}.`
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function getStripeConnectionIssue(provider?: PaymentProviderConfig): StripeConnectionIssue | null {
  const connectionData = provider?.connectionData
  const requirements = connectionData?.requirements
  const requirementErrors = requirements?.errors ?? []
  const disabledReason = connectionData?.disabledReason ?? requirements?.disabled_reason ?? null
  const failedReasons = uniqueStrings(
    requirementErrors
      .map((error) => error.reason)
      .filter((reason): reason is string => Boolean(reason))
  )
  const requiredFields = uniqueStrings(
    [
      ...requirementErrors
        .map((error) => error.requirement)
        .filter((requirement): requirement is string => Boolean(requirement)),
      ...(requirements?.past_due ?? []),
      ...(requirements?.currently_due ?? []),
    ].map(formatStripeRequirement)
  )

  if (!disabledReason && failedReasons.length === 0 && requiredFields.length === 0) {
    return null
  }

  return {
    title: failedReasons.length > 0 ? "Stripe verification failed" : "Stripe needs more details",
    description:
      failedReasons[0] ??
      formatStripeDisabledReason(disabledReason) ??
      "Complete the required Stripe account information before enabling payments.",
    fields: requiredFields,
  }
}

function deriveStripeStatus({
  provider,
  enabled,
}: {
  provider?: PaymentProviderConfig
  enabled: boolean
}): ProviderUiStatus | undefined {
  if (!enabled) {
    return undefined
  }

  switch (provider?.status) {
    case "active":
      return "ready"
    case "disabled":
      return "disabled"
    case "restricted":
      return "restricted"
    default:
      return "needs_onboarding"
  }
}

export function PaymentProviderConfigForm({
  provider,
  paymentProvider,
  setDialogOpen,
  onSuccess,
  skip,
  onSkip,
  isOnboarding,
}: {
  provider?: PaymentProviderConfig
  paymentProvider: PaymentProvider
  setDialogOpen?: (open: boolean) => void
  onSuccess?: (key: string) => void
  skip?: boolean
  onSkip?: () => void
  isOnboarding?: boolean
}) {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const trpc = useTRPC()
  let projectSlug = params.projectSlug as string
  const [enabledOverride, setEnabledOverride] = useState<boolean | null>(null)

  if (!projectSlug) {
    projectSlug = searchParams.get("projectSlug") as string
  }

  useEffect(() => {
    setEnabledOverride(null)
  }, [provider?.active, provider?.id, provider?.updatedAtM])

  const startConnection = useMutation(
    trpc.paymentProvider.startConnection.mutationOptions({
      onSuccess: (data) => {
        window.location.assign(data.url)
      },
    })
  )

  const refreshConnection = useMutation(
    trpc.paymentProvider.refreshConnection.mutationOptions({
      onSuccess: (data) => {
        window.location.assign(data.url)
      },
    })
  )

  const getConnection = useMutation(
    trpc.paymentProvider.getConnection.mutationOptions({
      onSuccess: () => {
        toastAction("updated")
        router.refresh()
      },
    })
  )

  const setEnabled = useMutation(
    trpc.paymentProvider.setEnabled.mutationOptions({
      onMutate: (variables) => {
        setEnabledOverride(variables.enabled)
      },
      onSuccess: (data, variables) => {
        toastAction("updated")
        setDialogOpen?.(false)
        if (variables.enabled) {
          onSuccess?.(data.paymentProviderConfig?.paymentProvider ?? paymentProvider)
        }
        router.refresh()
      },
      onError: (error) => {
        setEnabledOverride(null)
        toastAction("error", error.message)
      },
    })
  )

  const startOrRefreshConnection = async (kind: "start" | "refresh") => {
    const currentUrl = new URL(window.location.href)
    currentUrl.searchParams.set("provider", paymentProvider)

    const payload = {
      paymentProvider,
      returnUrl: currentUrl.toString(),
      refreshUrl: currentUrl.toString(),
      ...(projectSlug ? { projectSlug } : {}),
    }

    if (kind === "start") {
      await startConnection.mutateAsync(payload)
      return
    }

    await refreshConnection.mutateAsync(payload)
  }

  const toggleProvider = (enabled: boolean) => {
    if (paymentProvider === "stripe" && enabled && !provider?.externalAccountId) {
      toastAction("error", "Connect Stripe before enabling this provider.")
      return
    }

    setEnabled.mutate({ paymentProvider, enabled })
  }

  const isStripe = paymentProvider === "stripe"
  const isSandbox = paymentProvider === "sandbox"
  const enabled = enabledOverride ?? Boolean(provider?.active)
  const hasStripeAccount = Boolean(provider?.externalAccountId)
  const connectSubmitting = startConnection.isPending || refreshConnection.isPending
  const rowStatus: ProviderUiStatus | undefined = isSandbox
    ? enabled
      ? "sandbox"
      : undefined
    : deriveStripeStatus({ provider, enabled })
  const status = rowStatus ? STATUS_META[rowStatus] : null
  const stripeConnectionIssue = isStripe ? getStripeConnectionIssue(provider) : null
  const toggleDisabled =
    setEnabled.isPending ||
    (isStripe && !enabled && !hasStripeAccount) ||
    paymentProvider === "square"
  const switchCopy = enabled ? "Enabled for new subscriptions" : "Paused for new subscriptions"

  return (
    <div className="rounded-md border bg-background-bgSubtle/30">
      <div className="grid gap-6 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
        <div className="min-w-0 space-y-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
              {isSandbox ? (
                <TestTube2 className="size-3.5 text-muted-foreground" />
              ) : (
                <CreditCard className="size-3.5 text-muted-foreground" />
              )}
            </div>
            {status && (
              <Badge variant={status.variant} className="h-7">
                {status.label}
              </Badge>
            )}
            {provider?.mode === "test" && isStripe && (
              <Badge variant="outline" className="h-7 text-muted-foreground">
                Test
              </Badge>
            )}
            {provider?.externalAccountId && (
              <span className="truncate font-mono text-muted-foreground text-xs">
                {provider.externalAccountId}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="font-medium text-sm">
              {isSandbox ? "Sandbox test provider" : "Stripe Connect"}
            </p>
            <p className="max-w-4xl text-muted-foreground text-xs leading-5">
              {isSandbox
                ? "Test subscriptions without external credentials. Sandbox can be enabled or paused at any time."
                : "Products, customers, invoices, payments, disputes, and payouts stay in the connected Stripe account. Connect webhooks are handled by Unprice."}
            </p>
          </div>

          {skip && isOnboarding && isSandbox && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                onClick={() => setEnabled.mutate({ paymentProvider: "sandbox", enabled: true })}
                disabled={setEnabled.isPending}
              >
                Use Sandbox
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDialogOpen?.(false)
                  onSkip?.()
                }}
              >
                Skip
              </Button>
            </div>
          )}

          {stripeConnectionIssue && (
            <div className="warning flex gap-3 rounded-md p-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 space-y-2">
                <div className="space-y-1">
                  <p className="font-medium text-sm">{stripeConnectionIssue.title}</p>
                  <p className="text-xs leading-5">{stripeConnectionIssue.description}</p>
                </div>
                {stripeConnectionIssue.fields.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {stripeConnectionIssue.fields.map((field) => (
                      <Badge key={field} variant="outline" className="bg-background/60">
                        {field}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 sm:items-end">
          {isStripe && (
            <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
              {!hasStripeAccount && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => startOrRefreshConnection("start")}
                  disabled={connectSubmitting}
                >
                  <ExternalLink className="mr-2 size-3.5" />
                  Connect Stripe
                </Button>
              )}
              {hasStripeAccount && provider?.status !== "active" && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => startOrRefreshConnection("refresh")}
                  disabled={connectSubmitting}
                >
                  <ExternalLink className="mr-2 size-3.5" />
                  Continue onboarding
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => getConnection.mutate({ paymentProvider })}
                disabled={getConnection.isPending}
              >
                <RefreshCw
                  className={cn("mr-2 size-3.5", getConnection.isPending && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 sm:justify-end">
            <span className="text-muted-foreground text-xs">{switchCopy}</span>
            <Switch
              checked={enabled}
              onCheckedChange={toggleProvider}
              disabled={toggleDisabled}
              aria-label={`${isSandbox ? "Sandbox" : "Stripe"} provider enabled`}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
