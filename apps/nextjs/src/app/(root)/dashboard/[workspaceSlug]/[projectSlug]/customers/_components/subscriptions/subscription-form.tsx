"use client"
import type { InsertSubscription, Subscription, SubscriptionItem } from "@unprice/db/validators"
import { subscriptionInsertSchema } from "@unprice/db/validators"
import { Form } from "@unprice/ui/form"
import { Typography } from "@unprice/ui/typography"
import { AlertCircle } from "lucide-react"
import { useParams, useRouter } from "next/navigation"
import { useEffect } from "react"
import type { z } from "zod"
import { CopyButton } from "~/components/copy-button"
import TimeZoneFormField from "~/components/forms/timezone-field"
import { SubmitButton } from "~/components/submit-button"
import { formatDate } from "~/lib/dates"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"
import CustomerFormField from "./customer-field"
import { SubscriptionCancelButton } from "./subscription-cancel-button"
import SubscriptionPhaseFormField from "./subscription-phase-field"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Separator } from "@unprice/ui/separator"

export function SubscriptionForm({
  setDialogOpen,
  defaultValues,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues:
    | (InsertSubscription & { items?: SubscriptionItem[] })
    | (Subscription & { items?: SubscriptionItem[] })
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const isEdit = !!defaultValues.id
  const isInactive = isEdit && !defaultValues.active

  const { workspaceSlug, projectSlug } = useParams()

  const createSubscription = useMutation(
    trpc.subscriptions.create.mutationOptions({
      onSuccess: ({ subscription }) => {
        form.reset(subscription)
        toastAction("saved", "Subscription created")
        setDialogOpen?.(false)
        router.refresh()

        router.push(`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${subscription.id}`)
      },
    })
  )

  // customer lists
  const { data: customers } = useQuery(
    trpc.customers.listByActiveProject.queryOptions(
      {
        search: null,
        from: null,
        to: null,
        page: 1,
        page_size: 100,
      },
      {
        enabled: defaultValues.customerId === "",
      }
    )
  )

  const formSchema = subscriptionInsertSchema

  const form = useZodForm({
    schema: formSchema,
    defaultValues: defaultValues,
  })

  const customerId = form.watch("customerId")
  const selectedCustomer = customers?.customers.find((customer) => customer.id === customerId)

  // keep in sync with the customer timezone
  useEffect(() => {
    if (selectedCustomer?.timezone) {
      form.setValue("timezone", selectedCustomer.timezone)
    }
  }, [customerId])

  const onSubmitForm = async (data: z.infer<typeof formSchema>) => {
    if (!defaultValues.id) {
      await createSubscription.mutateAsync(data as InsertSubscription)
    }
  }

  return (
    <Form {...form}>
      <form
        id={"subscription-form"}
        onSubmit={form.handleSubmit(onSubmitForm)}
        className="space-y-6"
      >
        {isInactive && (
          <Alert variant="info">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Subscription Cancelled</AlertTitle>
            <AlertDescription className="font-extralight">
              This subscription was cancelled and won't be billed neither renewed. All phases are
              inactive as well.
            </AlertDescription>
          </Alert>
        )}

        {isEdit && (
          <>
            <div className="flex items-start gap-2">
              <div className="flex flex-col items-start gap-2">
                <Typography variant="h6">Subscription ID</Typography>
                <Typography variant="p" affects="removePaddingMargin">
                  {defaultValues.id}
                </Typography>
              </div>
              <CopyButton value={defaultValues.id ?? ""} className="size-4" />
            </div>
            <div className="flex flex-col items-start gap-2">
              <Typography variant="h6">Current Billing Cycle</Typography>
              <Typography variant="p" affects="removePaddingMargin">
                {formatDate(
                  defaultValues.currentCycleStartAt!,
                  defaultValues.timezone,
                  "MMM dd, yyyy HH:mm"
                )}{" "}
                {" -> "}
                {formatDate(
                  defaultValues.currentCycleEndAt!,
                  defaultValues.timezone,
                  "MMM dd, yyyy HH:mm"
                )}
              </Typography>
            </div>
          </>
        )}

        <div className="space-y-8">
          <Separator className="my-4" />

          <CustomerFormField form={form} isDisabled={isEdit} />

          <TimeZoneFormField form={form} isDisabled={isEdit} />

          <SubscriptionPhaseFormField
            form={form}
            // when creating a subscription, we don't have an id yet
            // although the empty id is not used in the backend
            subscriptionId={defaultValues.id ?? ""}
            timezone={defaultValues.timezone ?? selectedCustomer?.timezone ?? ""}
          />

          <Separator className="my-4" />
        </div>

        <div className="flex justify-end gap-4">
          {isEdit && !isInactive && <SubscriptionCancelButton subscriptionId={defaultValues.id!} />}

          {!isEdit && !isInactive && (
            <SubmitButton
              form="subscription-form"
              onClick={() => form.handleSubmit(onSubmitForm)()}
              isSubmitting={form.formState.isSubmitting}
              isDisabled={form.formState.isSubmitting}
              label="Create subscription"
            />
          )}
        </div>
      </form>
    </Form>
  )
}
