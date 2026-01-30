"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import {
  type InsertSubscriptionPhase,
  type SubscriptionPhase,
  subscriptionPhaseInsertSchema,
  subscriptionPhaseSelectSchema,
} from "@unprice/db/validators"
import { Form } from "@unprice/ui/form"
import { Separator } from "@unprice/ui/separator"
import { useEffect } from "react"
import { z } from "zod"
import ConfigItemsFormField from "~/components/forms/items-fields"
import PaymentMethodsFormField from "~/components/forms/payment-method-field"
import SelectPlanFormField from "~/components/forms/select-plan-field"
import TrialUnitsFormField from "~/components/forms/trial-days-field"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"
import DurationFormField from "./duration-field"

export function SubscriptionPhaseForm({
  setDialogOpen,
  defaultValues,
  onSubmit,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: InsertSubscriptionPhase | Partial<SubscriptionPhase>
  onSubmit: (data: InsertSubscriptionPhase | SubscriptionPhase) => void
}) {
  const trpc = useTRPC()
  const editMode = defaultValues.id !== "" && defaultValues.id !== undefined

  const formSchema = editMode
    ? subscriptionPhaseSelectSchema
    : subscriptionPhaseInsertSchema.superRefine((data, ctx) => {
        if (data.paymentMethodRequired) {
          if (!data.paymentMethodId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Payment method is required for this phase",
              path: ["paymentMethodId"],
            })

            return false
          }

          return true
        }
      })

  const form = useZodForm({
    schema: formSchema,
    defaultValues,
  })

  const createPhase = useMutation(
    trpc.subscriptions.createPhase.mutationOptions({
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  const updatePhase = useMutation(
    trpc.subscriptions.updatePhase.mutationOptions({
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  const onSubmitForm = async (data: InsertSubscriptionPhase | Partial<SubscriptionPhase>) => {
    // if subscription is not created yet no need to create phase
    if (!defaultValues.subscriptionId) {
      onSubmit(data as InsertSubscriptionPhase)
      setDialogOpen?.(false)
      return
    }

    if (editMode) {
      const { phase } = await updatePhase.mutateAsync({
        ...data,
        id: defaultValues.id!,
      } as SubscriptionPhase)

      onSubmit(phase)
      setDialogOpen?.(false)
    } else {
      const { phase } = await createPhase.mutateAsync(data as InsertSubscriptionPhase)

      onSubmit(phase)
      setDialogOpen?.(false)
    }
  }

  // all this querues are deduplicated inside each form field
  const { data: planVersions, isLoading } = useQuery(
    trpc.planVersions.listByActiveProject.queryOptions({
      onlyPublished: true,
      onlyLatest: false,
    })
  )

  const selectedPlanVersionId = form.watch("planVersionId")
  const selectedPlanVersion = planVersions?.planVersions.find(
    (version) => version.id === selectedPlanVersionId
  )

  // when plan is selected set payment method required to true
  useEffect(() => {
    if (selectedPlanVersion) {
      form.setValue("paymentMethodRequired", selectedPlanVersion.paymentMethodRequired)
      form.setValue("paymentMethodId", defaultValues.paymentMethodId)
      form.setValue("trialUnits", selectedPlanVersion.trialUnits)
    }
  }, [selectedPlanVersionId])

  return (
    <Form {...form}>
      <form className="space-y-6">
        <SelectPlanFormField
          form={form}
          isDisabled={editMode}
          planVersions={planVersions?.planVersions ?? []}
          isLoading={isLoading}
        />

        <Separator />

        <div className="flex flex-col items-center justify-start gap-4 lg:flex-row">
          <DurationFormField form={form} startDisabled={editMode} className="w-full" />

          <TrialUnitsFormField
            form={form}
            isDisabled={editMode || !selectedPlanVersion?.paymentMethodRequired}
            className="w-full"
          />
        </div>

        {selectedPlanVersion?.paymentProvider && selectedPlanVersion?.paymentMethodRequired && (
          <PaymentMethodsFormField
            form={form}
            withSeparator
            paymentProvider={selectedPlanVersion?.paymentProvider}
            paymentProviderRequired={selectedPlanVersion?.paymentMethodRequired}
          />
        )}

        <ConfigItemsFormField
          form={form}
          withSeparator
          isDisabled={editMode}
          planVersions={planVersions?.planVersions ?? []}
          isLoading={isLoading}
        />

        <div className="mt-8 flex justify-end space-x-4">
          <SubmitButton
            onClick={() => form.handleSubmit(onSubmitForm)()}
            isSubmitting={form.formState.isSubmitting}
            isDisabled={form.formState.isSubmitting}
            label={editMode ? "Update" : "Create"}
          />
        </div>
      </form>
    </Form>
  )
}
