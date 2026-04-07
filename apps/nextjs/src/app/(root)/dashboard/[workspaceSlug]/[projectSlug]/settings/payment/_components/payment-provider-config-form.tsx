"use client"
import { useMutation } from "@tanstack/react-query"
import type {
  InsertPaymentProviderConfig,
  PaymentProvider,
  PaymentProviderConfig,
} from "@unprice/db/validators"
import { insertPaymentProviderConfigSchema } from "@unprice/db/validators"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { useParams, useSearchParams } from "next/navigation"
import { revalidateAppPath } from "~/actions/revalidate"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"

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

  const form = useZodForm({
    schema: insertPaymentProviderConfigSchema,
    defaultValues: provider ?? {
      paymentProvider: paymentProvider,
      key: "",
      keyIv: "",
      webhookSecret: "",
      active: true,
      // from onboarding we can't infer the projectSlug, so we pass it as a search param
      ...(projectSlug ? { projectSlug } : {}),
    },
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (data: InsertPaymentProviderConfig) => {
          await saveConfig.mutateAsync(data)
        })}
        className="space-y-2"
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
  )
}
