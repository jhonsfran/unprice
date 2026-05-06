"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import {
  type InsertSubscriptionPhase,
  type SubscriptionPhase,
  getTrialUnitLabel,
  subscriptionPhaseInsertSchema,
  subscriptionPhaseSelectSchema,
} from "@unprice/db/validators"
import { fromLedgerAmount, fromLedgerMinor, toDecimal, toLedgerMinor } from "@unprice/money"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { useParams } from "next/navigation"
import { useEffect, useState } from "react"
import { z } from "zod"
import { PaymentProviderFormField } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/version-fields-form"
import ConfigItemsFormField from "~/components/forms/items-fields"
import PaymentMethodsFormField from "~/components/forms/payment-method-field"
import SelectPlanFormField from "~/components/forms/select-plan-field"
import TrialUnitsFormField from "~/components/forms/trial-days-field"
import { InputWithAddons } from "~/components/input-addons"
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
  const params = useParams()
  const workspaceSlug = params.workspaceSlug as string
  const projectSlug = params.projectSlug as string
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
  const selectedPaymentProvider = form.watch("paymentProvider")
  const paymentMethodRequired = form.watch("paymentMethodRequired")
  const selectedPlanVersion = planVersions?.planVersions.find(
    (version) => version.id === selectedPlanVersionId
  )
  const selectedCurrency = selectedPlanVersion?.currency ?? "USD"
  const creditLinePolicy = form.watch("creditLinePolicy")
  const trialUnitLabel = selectedPlanVersion
    ? getTrialUnitLabel({
        billingInterval: selectedPlanVersion.billingConfig.billingInterval,
        units: form.watch("trialUnits"),
      })
    : "days"

  // when plan is selected set payment method required to true
  useEffect(() => {
    if (selectedPlanVersion) {
      form.setValue("paymentMethodRequired", selectedPlanVersion.paymentMethodRequired)
      form.setValue("paymentProvider", selectedPlanVersion.paymentProvider)
      form.setValue("paymentMethodId", defaultValues.paymentMethodId)
      form.setValue("trialUnits", selectedPlanVersion.trialUnits)
      form.setValue("creditLinePolicy", form.getValues("creditLinePolicy") ?? "uncapped")
      form.setValue("creditLineAmount", form.getValues("creditLineAmount") ?? null)
    }
  }, [selectedPlanVersion, defaultValues.paymentMethodId, form])

  return (
    <Form {...form}>
      <form className="space-y-6">
        <SelectPlanFormField
          form={form}
          isDisabled={editMode}
          planVersions={planVersions?.planVersions ?? []}
          isLoading={isLoading}
        />

        <PaymentProviderFormField
          form={form}
          isDisabled={true}
          workspaceSlug={workspaceSlug}
          projectSlug={projectSlug}
        />

        <Separator />

        <div className="grid gap-4 lg:grid-cols-2">
          <FormField
            control={form.control}
            name="creditLinePolicy"
            render={({ field }) => (
              <FormItem className="flex w-full flex-col">
                <div className="flex items-center gap-1">
                  <FormLabel>Usage credit policy</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[260px]">
                      Capped reserves a finite usage runway. Uncapped lets priced usage continue and
                      invoice at period end.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select
                  onValueChange={(value) => {
                    field.onChange(value)
                    if (value === "uncapped") {
                      form.setValue("creditLineAmount", null)
                    }
                  }}
                  value={field.value ?? "uncapped"}
                  disabled={!selectedPlanVersion}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select usage credit policy" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="capped">Capped</SelectItem>
                    <SelectItem value="uncapped">Uncapped</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="creditLineAmount"
            render={({ field }) => (
              <FormItem className="flex w-full flex-col">
                <div className="flex items-center gap-1">
                  <FormLabel>Usage credit amount</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[260px]">
                      Leave empty to derive the cap from finite usage limits. Use 0 to allow no
                      postpaid runway.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <FormControl>
                  <CreditLineAmountInput
                    value={field.value}
                    onChange={field.onChange}
                    currency={selectedCurrency}
                    disabled={!selectedPlanVersion || creditLinePolicy === "uncapped"}
                  />
                </FormControl>
                <FormDescription>
                  {creditLinePolicy === "uncapped"
                    ? "Uncapped phases do not use a wallet credit amount."
                    : "Empty derives from finite usage limits."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex flex-col items-center justify-start gap-4 lg:flex-row">
          <DurationFormField form={form} startDisabled={editMode} className="w-full" />

          <TrialUnitsFormField
            form={form}
            isDisabled={editMode || !selectedPlanVersion}
            className="w-full"
            unitLabel={trialUnitLabel}
          />
        </div>

        {selectedPaymentProvider && paymentMethodRequired && (
          <PaymentMethodsFormField
            form={form}
            withSeparator
            paymentProvider={selectedPaymentProvider}
            paymentProviderRequired={paymentMethodRequired}
          />
        )}

        <ConfigItemsFormField
          form={form}
          withSeparator
          isDisabled={editMode}
          planVersions={planVersions?.planVersions ?? []}
          isLoading={isLoading}
          withFeatureDetails
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

function CreditLineAmountInput({
  value,
  onChange,
  currency,
  disabled,
}: {
  value: unknown
  onChange: (value: number | null) => void
  currency: string
  disabled?: boolean
}) {
  const [displayValue, setDisplayValue] = useState(() =>
    formatCreditLineAmount(normalizeCreditLineAmount(value), currency)
  )

  useEffect(() => {
    setDisplayValue(formatCreditLineAmount(normalizeCreditLineAmount(value), currency))
  }, [currency, value])

  return (
    <InputWithAddons
      inputMode="decimal"
      placeholder="Derived"
      leading={currency}
      value={displayValue}
      disabled={disabled}
      onChange={(event) => {
        const nextValue = event.target.value
        setDisplayValue(nextValue)

        if (nextValue.trim() === "") {
          onChange(null)
          return
        }

        try {
          const parsed = toLedgerMinor(fromLedgerAmount(nextValue, currency))
          if (Number.isFinite(parsed) && parsed >= 0) {
            onChange(parsed)
          }
        } catch {
          return
        }
      }}
      onBlur={() => {
        setDisplayValue(formatCreditLineAmount(normalizeCreditLineAmount(value), currency))
      }}
    />
  )
}

function normalizeCreditLineAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function formatCreditLineAmount(value: number | null, currency: string): string {
  return value === null
    ? ""
    : toDecimal(fromLedgerMinor(value, currency))
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "")
}
