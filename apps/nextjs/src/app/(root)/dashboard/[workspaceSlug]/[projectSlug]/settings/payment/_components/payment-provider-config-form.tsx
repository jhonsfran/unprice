"use client"
import { useMutation } from "@tanstack/react-query"
import type {
  InsertPaymentProviderConfig,
  PaymentProvider,
  PaymentProviderConfig,
} from "@unprice/db/validators"
import { insertPaymentProviderConfigSchema } from "@unprice/db/validators"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { ExternalLink, RefreshCw, Unplug } from "lucide-react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { z } from "zod"
import { revalidateAppPath } from "~/actions/revalidate"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

const STATUS_LABELS: Record<PaymentProviderConfig["status"], string> = {
  not_connected: "Not connected",
  pending: "Pending",
  active: "Connected",
  restricted: "Restricted",
  disabled: "Disabled",
}

const STATUS_VARIANTS: Record<
  PaymentProviderConfig["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  not_connected: "outline",
  pending: "secondary",
  active: "default",
  restricted: "secondary",
  disabled: "destructive",
}

const byokPaymentProviderConfigSchema = insertPaymentProviderConfigSchema.extend({
  key: z.string().min(1),
})

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
  const workspaceSlug = params.workspaceSlug as string
  let projectSlug = params.projectSlug as string

  if (!projectSlug) {
    projectSlug = searchParams.get("projectSlug") as string
  }

  const saveConfig = useMutation(
    trpc.paymentProvider.saveConfig.mutationOptions({
      onSuccess: (data) => {
        toastAction("saved")
        setDialogOpen?.(false)
        onSuccess?.(data.paymentProviderConfig.paymentProvider)
        revalidateAppPath(`/${workspaceSlug}/${projectSlug}/settings/payment`, "page")
      },
    })
  )

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

  const disconnectConnection = useMutation(
    trpc.paymentProvider.disconnectConnection.mutationOptions({
      onSuccess: () => {
        toastAction("removed")
        router.refresh()
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

  const normalizedProvider = provider
    ? {
        ...provider,
        key: "",
        keyIv: "",
        webhookSecret: "",
        webhookSecretIv: "",
        ...(projectSlug ? { projectSlug } : {}),
      }
    : undefined

  const form = useZodForm({
    schema: byokPaymentProviderConfigSchema,
    defaultValues: normalizedProvider ?? {
      paymentProvider: paymentProvider,
      key: "",
      keyIv: "",
      webhookSecret: "",
      active: true,
      // from onboarding we can't infer the projectSlug, so we pass it as a search param
      ...(projectSlug ? { projectSlug } : {}),
    },
  })

  const connectionStatus = provider?.status ?? "not_connected"
  const isManagedStripe =
    paymentProvider === "stripe" && provider?.connectionType === "managed_connection"
  const connectSubmitting = startConnection.isPending || refreshConnection.isPending
  const showAdvancedByok = paymentProvider !== "stripe" || !isManagedStripe

  return (
    <div className="space-y-4">
      {paymentProvider === "stripe" && (
        <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANTS[connectionStatus]}>
                {STATUS_LABELS[connectionStatus]}
              </Badge>
              {provider?.externalAccountId && (
                <span className="font-mono text-muted-foreground text-xs">
                  {provider.externalAccountId}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Stripe Connect keeps products, customers, invoices, payments, disputes, and payouts in
              the connected Stripe account. Webhooks are handled by Unprice.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => startOrRefreshConnection(isManagedStripe ? "refresh" : "start")}
              disabled={connectSubmitting}
            >
              <ExternalLink className="mr-2 size-3.5" />
              {isManagedStripe ? "Continue onboarding" : "Connect Stripe"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => getConnection.mutate({ paymentProvider })}
              disabled={getConnection.isPending}
            >
              <RefreshCw className="mr-2 size-3.5" />
              Refresh status
            </Button>
            {isManagedStripe && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => disconnectConnection.mutate({ paymentProvider })}
                disabled={disconnectConnection.isPending}
              >
                <Unplug className="mr-2 size-3.5" />
                Disconnect
              </Button>
            )}
          </div>
        </div>
      )}

      <details open={showAdvancedByok} className="space-y-2">
        <summary className="cursor-pointer font-medium text-muted-foreground text-xs">
          {paymentProvider === "stripe" ? "Advanced: bring your own key" : "Bring your own key"}
        </summary>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(async (data: InsertPaymentProviderConfig) => {
              await saveConfig.mutateAsync(data as InsertPaymentProviderConfig & { key: string })
            })}
            className="space-y-2 pt-2"
          >
            {/* <div className="flex flex-col items-end">
          <FormField
            control={form.control}
            name="active"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div> */}
            <FormField
              control={form.control}
              name="key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider Secret Key</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder="api key"
                      type="password"
                      disabled={!form.getValues("active")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="webhookSecret"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Webhook Secret (optional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder="provider webhook secret"
                      type="password"
                      disabled={!form.getValues("active")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-end justify-end gap-2 pt-4">
              {skip && (
                <SubmitButton
                  variant="ghost"
                  onClick={() => {
                    setDialogOpen?.(false)

                    if (isOnboarding) {
                      // create a default config for the onboarding
                      saveConfig.mutate({
                        paymentProvider: "sandbox",
                        key: "onboarding-key",
                        keyIv: "",
                        active: true,
                      })
                      return
                    }

                    onSkip?.()
                  }}
                  isDisabled={form.formState.isSubmitting}
                  isSubmitting={form.formState.isSubmitting}
                  label={isOnboarding ? "Use sandbox" : "Skip"}
                />
              )}

              <SubmitButton
                type="submit"
                isSubmitting={form.formState.isSubmitting}
                isDisabled={form.formState.isSubmitting || !form.getValues("active")}
                label={"Save"}
              />
            </div>
          </form>
        </Form>
      </details>
    </div>
  )
}
