"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider, PublicPaymentProviderConfig } from "@unprice/db/validators"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import { Switch } from "@unprice/ui/switch"
import { cn } from "@unprice/ui/utils"
import {
  CreditCard,
  ExternalLink,
  type LucideIcon,
  RefreshCw,
  TestTube2,
  TriangleAlert,
} from "lucide-react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { type ReactNode, useState } from "react"
import { toastAction } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

type ProviderUiStatus =
  | "ready"
  | "needs_onboarding"
  | "restricted"
  | "disabled"
  | "sandbox"
  | "not_connected"

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
  not_connected: { label: "Not connected", variant: "outline" },
}

type ProviderStatusMeta = (typeof STATUS_META)[ProviderUiStatus]

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

function getStripeConnectionIssue(
  provider?: PublicPaymentProviderConfig
): StripeConnectionIssue | null {
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

function deriveStripeStatus(provider?: PublicPaymentProviderConfig): ProviderUiStatus {
  if (!provider?.externalAccountId) {
    return "not_connected"
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

type PaymentProviderConfigFormProps = {
  provider?: PublicPaymentProviderConfig
  paymentProvider: PaymentProvider
  workspaceSlug?: string
  projectSlug?: string
  setDialogOpen?: (open: boolean) => void
  onSuccess?: (key: string) => void
  skip?: boolean
  onSkip?: () => void
  isOnboarding?: boolean
}

type ProjectMutationScope = {
  workspaceSlug?: string
  projectSlug?: string
}

function useProjectMutationScope(
  workspaceSlugProp?: string,
  projectSlugProp?: string
): ProjectMutationScope {
  const params = useParams()
  const searchParams = useSearchParams()
  const workspaceSlug =
    workspaceSlugProp ??
    (params.workspaceSlug as string | undefined) ??
    searchParams.get("workspaceSlug") ??
    undefined
  const projectSlug =
    projectSlugProp ??
    (params.projectSlug as string | undefined) ??
    searchParams.get("projectSlug") ??
    undefined

  return {
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(projectSlug ? { projectSlug } : {}),
  }
}

function ProviderCardShell({
  icon: Icon,
  title,
  description,
  status,
  badges,
  connectedAccountId,
  alert,
  actions,
  enabled,
  switchCopy,
  toggleDisabled,
  switchLabel,
  onToggle,
}: {
  icon: LucideIcon
  title: string
  description: string
  status: ProviderStatusMeta
  badges?: ReactNode
  connectedAccountId?: string | null
  alert?: ReactNode
  actions?: ReactNode
  enabled: boolean
  switchCopy: string
  toggleDisabled: boolean
  switchLabel: string
  onToggle: (enabled: boolean) => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background-bgSubtle">
              <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 md:justify-end">
            <Badge variant={status.variant} className="h-6">
              {status.label}
            </Badge>
            {badges}
          </div>
        </div>

        {connectedAccountId && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-2 text-muted-foreground text-xs">
            <span className="font-medium">Connected account</span>
            <span className="truncate font-mono">{connectedAccountId}</span>
          </div>
        )}

        {alert}
      </CardHeader>

      <CardFooter className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">{actions}</div>

        <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-end">
          <span className="text-muted-foreground text-xs">{switchCopy}</span>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={toggleDisabled}
            aria-label={switchLabel}
          />
        </div>
      </CardFooter>
    </Card>
  )
}

function StripeConnectionAlert({ issue }: { issue: StripeConnectionIssue }) {
  return (
    <Alert className="mt-2" variant="warning">
      <TriangleAlert className="size-5 text-warning-text" aria-hidden="true" />
      <AlertTitle className="text-sm">{issue.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2 text-xs">
        <p>{issue.description}</p>
        {issue.fields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {issue.fields.map((field) => (
              <Badge key={field} variant="outline">
                {field}
              </Badge>
            ))}
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}

function StripeProviderConfigCard({
  provider,
  enabled,
  setEnabledPending,
  connectSubmitting,
  getConnectionPending,
  onStartConnection,
  onRefreshConnection,
  onGetConnection,
  onToggle,
}: {
  provider?: PublicPaymentProviderConfig
  enabled: boolean
  setEnabledPending: boolean
  connectSubmitting: boolean
  getConnectionPending: boolean
  onStartConnection: () => void
  onRefreshConnection: () => void
  onGetConnection: () => void
  onToggle: (enabled: boolean) => void
}) {
  const hasStripeAccount = Boolean(provider?.externalAccountId)
  const stripeReady = hasStripeAccount && provider?.status === "active"
  const issue = getStripeConnectionIssue(provider)
  const switchCopy = enabled ? "Accepting new subscriptions" : "Paused for new subscriptions"
  const toggleDisabled = setEnabledPending || (!enabled && !stripeReady)

  const handleToggle = (nextEnabled: boolean) => {
    if (nextEnabled && !stripeReady) {
      toastAction(
        "error",
        "Complete Stripe onboarding and refresh the connection before enabling this provider."
      )
      return
    }

    onToggle(nextEnabled)
  }

  return (
    <ProviderCardShell
      icon={CreditCard}
      title="Stripe Connect"
      description="Collect subscription payments in Stripe while Unprice keeps plan versions, invoices, and webhook settlement evidence connected."
      status={STATUS_META[deriveStripeStatus(provider)]}
      badges={
        provider?.mode === "test" ? (
          <Badge variant="outline" className="h-6 text-muted-foreground">
            Test
          </Badge>
        ) : null
      }
      connectedAccountId={provider?.externalAccountId}
      alert={issue ? <StripeConnectionAlert issue={issue} /> : null}
      actions={
        <>
          {!hasStripeAccount && (
            <Button
              type="button"
              size="sm"
              onClick={onStartConnection}
              disabled={connectSubmitting}
            >
              <ExternalLink data-icon="inline-start" className="mr-1 size-3" aria-hidden="true" />
              Connect Stripe
            </Button>
          )}
          {hasStripeAccount && provider?.status !== "active" && (
            <Button
              type="button"
              size="sm"
              onClick={onRefreshConnection}
              disabled={connectSubmitting}
            >
              <ExternalLink data-icon="inline-start" className="mr-1 size-3" aria-hidden="true" />
              Continue onboarding
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onGetConnection}
            disabled={getConnectionPending}
          >
            <RefreshCw
              data-icon="inline-start"
              aria-hidden="true"
              className={cn("mr-1 size-3", {
                "animate-spin": getConnectionPending,
              })}
            />
            Refresh
          </Button>
        </>
      }
      enabled={enabled}
      switchCopy={switchCopy}
      toggleDisabled={toggleDisabled}
      switchLabel="Stripe provider enabled"
      onToggle={handleToggle}
    />
  )
}

function SandboxProviderConfigCard({
  enabled,
  setEnabledPending,
  hasOnboardingActions,
  onUseSandbox,
  onSkip,
  onToggle,
}: {
  enabled: boolean
  setEnabledPending: boolean
  hasOnboardingActions: boolean
  onUseSandbox: () => void
  onSkip: () => void
  onToggle: (enabled: boolean) => void
}) {
  const switchCopy = enabled ? "Accepting new subscriptions" : "Paused for new subscriptions"

  return (
    <ProviderCardShell
      icon={TestTube2}
      title="Sandbox test provider"
      description="Test subscriptions without external credentials. Sandbox can be enabled or paused at any time."
      status={STATUS_META.sandbox}
      actions={
        hasOnboardingActions ? (
          <>
            <Button type="button" size="sm" onClick={onUseSandbox} disabled={setEnabledPending}>
              Use Sandbox
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          </>
        ) : null
      }
      enabled={enabled}
      switchCopy={switchCopy}
      toggleDisabled={setEnabledPending}
      switchLabel="Sandbox provider enabled"
      onToggle={onToggle}
    />
  )
}

function UnsupportedProviderConfigCard({
  paymentProvider,
  enabled,
}: {
  paymentProvider: PaymentProvider
  enabled: boolean
}) {
  return (
    <ProviderCardShell
      icon={CreditCard}
      title={paymentProvider}
      description="This payment provider is not available yet."
      status={STATUS_META.disabled}
      enabled={enabled}
      switchCopy="Unavailable"
      toggleDisabled
      switchLabel={`${paymentProvider} provider enabled`}
      onToggle={() => undefined}
    />
  )
}

export function PaymentProviderConfigForm({
  provider,
  paymentProvider,
  workspaceSlug: workspaceSlugProp,
  projectSlug: projectSlugProp,
  setDialogOpen,
  onSuccess,
  skip,
  onSkip,
  isOnboarding,
}: PaymentProviderConfigFormProps) {
  const router = useRouter()
  const trpc = useTRPC()
  const projectScope = useProjectMutationScope(workspaceSlugProp, projectSlugProp)
  const providerStateKey = `${provider?.id ?? "new"}:${provider?.updatedAtM ?? "unknown"}`
  const [enabledOverride, setEnabledOverride] = useState<{
    providerStateKey: string
    enabled: boolean
  } | null>(null)
  const enabled =
    enabledOverride?.providerStateKey === providerStateKey
      ? enabledOverride.enabled
      : Boolean(provider?.active)

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
        setEnabledOverride({ providerStateKey, enabled: variables.enabled })
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
      ...projectScope,
    }

    if (kind === "start") {
      await startConnection.mutateAsync(payload)
      return
    }

    await refreshConnection.mutateAsync(payload)
  }

  const toggleProvider = (nextEnabled: boolean) => {
    setEnabled.mutate({ paymentProvider, enabled: nextEnabled, ...projectScope })
  }

  if (paymentProvider === "sandbox") {
    return (
      <SandboxProviderConfigCard
        enabled={enabled}
        setEnabledPending={setEnabled.isPending}
        hasOnboardingActions={Boolean(skip && isOnboarding)}
        onUseSandbox={() =>
          setEnabled.mutate({
            paymentProvider: "sandbox",
            enabled: true,
            ...projectScope,
          })
        }
        onSkip={() => {
          setDialogOpen?.(false)
          onSkip?.()
        }}
        onToggle={toggleProvider}
      />
    )
  }

  if (paymentProvider === "stripe") {
    return (
      <StripeProviderConfigCard
        provider={provider}
        enabled={enabled}
        setEnabledPending={setEnabled.isPending}
        connectSubmitting={startConnection.isPending || refreshConnection.isPending}
        getConnectionPending={getConnection.isPending}
        onStartConnection={() => startOrRefreshConnection("start")}
        onRefreshConnection={() => startOrRefreshConnection("refresh")}
        onGetConnection={() => getConnection.mutate({ paymentProvider, ...projectScope })}
        onToggle={toggleProvider}
      />
    )
  }

  return <UnsupportedProviderConfigCard paymentProvider={paymentProvider} enabled={enabled} />
}
