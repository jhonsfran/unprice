"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import {
  type InsertSubscriptionPhase,
  type SubscriptionChangePlan,
  type SubscriptionPhase,
  getTrialUnitLabel,
} from "@unprice/db/validators"
import { fromLedgerAmount, fromLedgerMinor, toDecimal, toLedgerMinor } from "@unprice/money"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { useParams, useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { type FieldValues, type UseFormReturn } from "react-hook-form"
import { PaymentProviderFormField } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/version-fields-form"
import ConfigItemsFormField from "~/components/forms/items-fields"
import PaymentMethodsFormField from "~/components/forms/payment-method-field"
import SelectPlanFormField from "~/components/forms/select-plan-field"
import TrialUnitsFormField from "~/components/forms/trial-days-field"
import { InputWithAddons } from "~/components/input-addons"
import { SubmitButton } from "~/components/submit-button"
import { formatDate } from "~/lib/dates"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { useTRPC } from "~/trpc/client"
import DurationFormField from "./duration-field"
import {
  createPhaseSchema,
  editablePhaseSchema,
  schedulePhaseSchema,
} from "./subscription-phase-schemas"
import type {
  SubscriptionPhaseFormDefaultValues,
  SubscriptionPhaseFormMode,
  SubscriptionPhaseFormSubmitValue,
} from "./subscription-phase-types"

export function SubscriptionPhaseForm({
  setDialogOpen,
  defaultValues,
  mode = "create",
  isReadOnly = false,
  onSubmit,
}: {
  setDialogOpen?: (open: boolean) => void
  defaultValues: SubscriptionPhaseFormDefaultValues
  mode?: SubscriptionPhaseFormMode
  isReadOnly?: boolean
  onSubmit: (data: SubscriptionPhaseFormSubmitValue) => void
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const params = useParams()
  const workspaceSlug = params.workspaceSlug as string
  const projectSlug = params.projectSlug as string
  const isScheduleMode = mode === "schedule"
  const isReadOnlyMode = isReadOnly || mode === "view"
  const isFutureEditMode = mode === "edit"
  const editMode = !isScheduleMode && defaultValues.id !== "" && defaultValues.id !== undefined
  const persistedPhaseFieldsLocked = editMode && !isFutureEditMode

  const formSchema = isScheduleMode
    ? schedulePhaseSchema
    : editMode
      ? editablePhaseSchema
      : createPhaseSchema

  const form = useZodForm({
    schema: formSchema,
    defaultValues,
  })
  const previousPlanVersionIdRef = useRef<string | undefined>(null)
  if (previousPlanVersionIdRef.current === null) {
    previousPlanVersionIdRef.current = form.getValues("planVersionId")
  }
  const nowMs = useMemo(() => Date.now(), [])

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

  const changePhasePlan = useMutation(
    trpc.subscriptions.changePhasePlan.mutationOptions({
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  const onSubmitForm = async (
    data: InsertSubscriptionPhase | Partial<SubscriptionPhase> | SubscriptionChangePlan
  ) => {
    if (isScheduleMode) {
      await changePhasePlan.mutateAsync(data as SubscriptionChangePlan)
      setDialogOpen?.(false)
      router.refresh()
      return
    }

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

      onSubmit({
        ...phase,
        planVersion: defaultValues.planVersion,
      } as SubscriptionPhaseFormSubmitValue)
      setDialogOpen?.(false)
    } else {
      const { phase } = await createPhase.mutateAsync(data as InsertSubscriptionPhase)

      onSubmit(phase as SubscriptionPhaseFormSubmitValue)
      setDialogOpen?.(false)
    }
  }

  // all this querues are deduplicated inside each form field
  const { data: planVersions, isLoading } = useQuery(
    trpc.planVersions.listByActiveProject.queryOptions({
      onlyPublished: true,
      onlyLatest: isScheduleMode,
    })
  )

  const selectedPlanVersionId = form.watch("planVersionId")
  const selectedPaymentProvider = form.watch("paymentProvider")
  const paymentMethodRequired = form.watch("paymentMethodRequired")
  const selectedPlanVersion =
    planVersions?.planVersions.find((version) => version.id === selectedPlanVersionId) ??
    (defaultValues.planVersion?.id === selectedPlanVersionId
      ? defaultValues.planVersion
      : undefined)
  const selectedPlanVersionPaymentMethodRequired = selectedPlanVersion?.paymentMethodRequired
  const selectedPlanVersionPaymentProvider = selectedPlanVersion?.paymentProvider
  const selectedPlanVersionTrialUnits = selectedPlanVersion?.trialUnits
  const selectedCurrency = selectedPlanVersion?.currency ?? "USD"
  const creditLinePolicy = form.watch("creditLinePolicy")
  const whenToChange = form.watch("whenToChange")
  const planVersionOptions = isScheduleMode
    ? (planVersions?.planVersions.filter(
        (version) => version.id !== defaultValues.currentPlanVersionId
      ) ?? [])
    : (planVersions?.planVersions ?? [])
  const isCreditLinePolicyDisabled =
    persistedPhaseFieldsLocked || isReadOnlyMode || !selectedPlanVersion
  const trialUnitLabel = selectedPlanVersion
    ? getTrialUnitLabel({
        billingInterval: selectedPlanVersion.billingConfig.billingInterval,
        units: form.watch("trialUnits"),
      })
    : "days"

  // when plan is selected set defaults controlled by the plan version
  useEffect(() => {
    if (!selectedPlanVersionId || !selectedPlanVersionPaymentProvider) return

    const planVersionChanged = previousPlanVersionIdRef.current !== selectedPlanVersionId
    previousPlanVersionIdRef.current = selectedPlanVersionId

    if (editMode && !planVersionChanged) {
      return
    }

    form.setValue("paymentMethodRequired", selectedPlanVersionPaymentMethodRequired ?? false)
    form.setValue("paymentProvider", selectedPlanVersionPaymentProvider)
    form.setValue("trialUnits", selectedPlanVersionTrialUnits ?? 0)
    form.setValue("creditLinePolicy", form.getValues("creditLinePolicy") ?? "uncapped")
    form.setValue("creditLineAmount", form.getValues("creditLineAmount") ?? null)
  }, [
    selectedPlanVersionId,
    selectedPlanVersionPaymentMethodRequired,
    selectedPlanVersionPaymentProvider,
    selectedPlanVersionTrialUnits,
    form,
    editMode,
  ])

  const whenToChangeOptions = useMemo(() => {
    const timezone = defaultValues.timezone ?? "UTC"

    const endOfCycleLabel = defaultValues.currentCycleEndAt
      ? formatDate(defaultValues.currentCycleEndAt, timezone, "MMM d, hh:mm")
      : formatDate(nowMs, timezone, "MMM d, hh:mm")

    const immediateLabel = formatDate(nowMs, timezone, "MMM d, hh:mm")

    return [
      {
        key: "end_of_cycle",
        label: `End of cycle (${endOfCycleLabel})`,
      },
      {
        key: "immediately",
        label: `Immediately (${immediateLabel})`,
      },
    ]
  }, [defaultValues.currentCycleEndAt, defaultValues.timezone, nowMs])

  const formFieldBehavior = useMemo(
    () => ({
      isCreditLinePolicyDisabled,
      isReadOnlyMode,
      isScheduleMode,
      persistedPhaseFieldsLocked,
    }),
    [isCreditLinePolicyDisabled, isReadOnlyMode, isScheduleMode, persistedPhaseFieldsLocked]
  )

  return (
    <Form {...form}>
      <SubscriptionPhaseFormFields
        form={form}
        formFieldBehavior={formFieldBehavior}
        paymentProvider={selectedPaymentProvider}
        selectedPlanVersionPaymentProvider={selectedPlanVersionPaymentProvider}
        hasSelectedPlanVersion={Boolean(selectedPlanVersion)}
        paymentMethodRequired={paymentMethodRequired}
        creditLinePolicy={creditLinePolicy}
        selectedCurrency={selectedCurrency}
        whenToChange={whenToChange}
        workspaceSlug={workspaceSlug}
        projectSlug={projectSlug}
        planVersionOptions={planVersionOptions}
        isLoading={isLoading}
        planVersion={defaultValues.planVersion}
        trialUnitLabel={trialUnitLabel}
        whenToChangeOptions={whenToChangeOptions}
        formStateSubmitting={form.formState.isSubmitting}
        editMode={editMode}
        onSubmit={async () => form.handleSubmit(onSubmitForm)()}
      />
    </Form>
  )
}

type SubscriptionPhaseFormFieldBehavior = {
  isCreditLinePolicyDisabled: boolean
  isReadOnlyMode: boolean
  isScheduleMode: boolean
  persistedPhaseFieldsLocked: boolean
}

function SubscriptionPhaseFormFields({
  form,
  formFieldBehavior,
  paymentMethodRequired,
  creditLinePolicy,
  selectedCurrency,
  whenToChange,
  workspaceSlug,
  projectSlug,
  planVersionOptions,
  isLoading,
  planVersion,
  trialUnitLabel,
  whenToChangeOptions,
  formStateSubmitting,
  selectedPlanVersionPaymentProvider,
  hasSelectedPlanVersion,
  onSubmit,
  editMode,
  paymentProvider,
}: {
  form: UseFormReturn<FieldValues>
  formFieldBehavior: SubscriptionPhaseFormFieldBehavior
  paymentMethodRequired: boolean | undefined
  creditLinePolicy: unknown
  selectedCurrency: string
  whenToChange: string | undefined
  workspaceSlug: string
  projectSlug: string
  planVersionOptions: Array<{ id: string }>
  isLoading?: boolean
  planVersion: SubscriptionPhaseFormDefaultValues["planVersion"]
  trialUnitLabel: string
  whenToChangeOptions: { key: string; label: string }[]
  formStateSubmitting: boolean
  selectedPlanVersionPaymentProvider: string | undefined
  hasSelectedPlanVersion: boolean
  paymentProvider: string | undefined
  onSubmit: () => void
  editMode: boolean
}) {
  const {
    isCreditLinePolicyDisabled,
    isReadOnlyMode,
    isScheduleMode,
    persistedPhaseFieldsLocked,
  } = formFieldBehavior
  const paymentProviderValue = paymentProvider ?? selectedPlanVersionPaymentProvider
  return (
    <form className="space-y-6">
      <SelectPlanFormField
        form={form}
        isDisabled={persistedPhaseFieldsLocked || isReadOnlyMode}
        planVersions={planVersionOptions}
        selectedPlanVersionFallback={planVersion}
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
                disabled={isCreditLinePolicyDisabled}
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
                    {getCreditLineAmountHelpText(persistedPhaseFieldsLocked, creditLinePolicy)}
                  </TooltipContent>
                </Tooltip>
              </div>
              <FormControl>
                <CreditLineAmountInput
                  value={field.value}
                  onChange={field.onChange}
                  currency={selectedCurrency}
                  disabled={isCreditLinePolicyDisabled || creditLinePolicy === "uncapped"}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="flex flex-col items-center justify-start gap-4 lg:flex-row">
        {isScheduleMode ? (
          <FormField
            control={form.control}
            name={"whenToChange"}
            render={({ field }) => (
              <FormItem className="flex w-full flex-col">
                <div className="flex items-center gap-1">
                  <FormLabel>When to change</FormLabel>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[260px]">
                      Choose when the new phase should become active.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select onValueChange={field.onChange} value={field.value ?? "end_of_cycle"}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select timing" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {whenToChangeOptions.map((type) => (
                      <SelectItem key={type.key} value={type.key} description={type.label}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <DurationFormField
            form={form}
            startDisabled={persistedPhaseFieldsLocked || isReadOnlyMode}
            endDisabled={isReadOnlyMode}
            className="w-full"
          />
        )}

        <TrialUnitsFormField
          form={form}
          isDisabled={persistedPhaseFieldsLocked || isReadOnlyMode || !hasSelectedPlanVersion}
          className="w-full"
          unitLabel={trialUnitLabel}
        />
      </div>

      {paymentProviderValue && paymentMethodRequired && (
        <PaymentMethodsFormField
          form={form}
          withSeparator
          isDisabled={isReadOnlyMode}
          paymentProvider={paymentProviderValue}
          paymentProviderRequired={paymentMethodRequired}
        />
      )}

        <ConfigItemsFormField
          form={form}
          withSeparator
          isDisabled={persistedPhaseFieldsLocked || isReadOnlyMode}
          planVersions={planVersionOptions}
          isLoading={isLoading}
          withFeatureDetails
        />

      {!isReadOnlyMode && (
        <div className="mt-8 flex justify-end gap-4">
          <SubmitButton
            onClick={onSubmit}
            isSubmitting={formStateSubmitting}
            isDisabled={formStateSubmitting}
            label={
              isScheduleMode
                ? whenToChange === "immediately"
                  ? "Change now"
                  : "Add phase"
                : editMode
                  ? "Update"
                  : "Create"
            }
            withConfirmation={isScheduleMode}
            confirmationMessage="Are you sure you want to add this phase? The current phase will be closed according to the selected timing."
          />
        </div>
      )}
    </form>
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

function getCreditLineAmountHelpText(fieldsLocked: boolean, creditLinePolicy: unknown): string {
  if (fieldsLocked) {
    return "Saved phases keep their original usage credit policy."
  }

  if (creditLinePolicy === "uncapped") {
    return "Uncapped phases do not use a wallet credit amount."
  }

  return "Leave empty to derive the cap from finite usage limits. Use 0 to allow no postpaid runway."
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
