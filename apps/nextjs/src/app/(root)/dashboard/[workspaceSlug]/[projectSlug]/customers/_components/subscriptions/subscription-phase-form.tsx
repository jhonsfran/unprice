"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import {
  type CreditLinePolicy,
  type InsertSubscriptionPhase,
  type PaymentProvider,
  type SubscriptionChangePlan,
  type SubscriptionItem,
  type SubscriptionItemsConfig,
  type SubscriptionPhase,
  getTrialUnitLabel,
} from "@unprice/db/validators"
import { fromLedgerAmount, fromLedgerMinor, toDecimal, toLedgerMinor } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { useParams, useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FieldPath, FieldValues, PathValue, UseFormReturn } from "react-hook-form"
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

type PlanVersionOptions = RouterOutputs["planVersions"]["listByActiveProject"]["planVersions"]
type WhenToChangeOption = {
  key: "end_of_cycle" | "immediately"
  label: string
}

interface SubscriptionPhaseFieldValues extends FieldValues {
  planVersionId: string
  paymentProvider?: PaymentProvider
  paymentMethodRequired?: boolean
  paymentMethodId?: string | null
  customerId?: string
  creditLinePolicy?: CreditLinePolicy
  creditLineAmount?: number | null
  startAt: number
  endAt?: number | null
  trialUnits?: number
  whenToChange?: string
  config?: SubscriptionItemsConfig
  items?: SubscriptionItem[]
  timezone?: string
}

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
  const previousPlanVersionIdRef = useRef<string | undefined | null>(null)
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
  const selectedPaymentProvider = form.watch("paymentProvider") as PaymentProvider | undefined
  const paymentMethodRequired = form.watch("paymentMethodRequired") as boolean | undefined
  const selectedPlanVersion =
    planVersions?.planVersions.find((version) => version.id === selectedPlanVersionId) ??
    (defaultValues.planVersion?.id === selectedPlanVersionId
      ? defaultValues.planVersion
      : undefined)
  const selectedPlanVersionPaymentMethodRequired = selectedPlanVersion?.paymentMethodRequired
  const selectedPlanVersionPaymentProvider = selectedPlanVersion?.paymentProvider ?? undefined
  const selectedPlanVersionTrialUnits = selectedPlanVersion?.trialUnits
  const selectedCurrency = selectedPlanVersion?.currency ?? "USD"
  const creditLinePolicy = form.watch("creditLinePolicy") as CreditLinePolicy | undefined
  const whenToChange = form.watch("whenToChange") as string | undefined
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
    ] satisfies WhenToChangeOption[]
  }, [defaultValues.currentCycleEndAt, defaultValues.timezone, nowMs])

  const paymentProviderValue = selectedPaymentProvider ?? selectedPlanVersionPaymentProvider

  return (
    <Form {...form}>
      <form className="space-y-6">
        <PlanAndProviderFields
          form={form}
          persistedPhaseFieldsLocked={persistedPhaseFieldsLocked}
          isReadOnlyMode={isReadOnlyMode}
          workspaceSlug={workspaceSlug}
          projectSlug={projectSlug}
          planVersionOptions={planVersionOptions}
          selectedPlanVersionFallback={defaultValues.planVersion}
          isLoading={isLoading}
        />

        <Separator />

        <UsageCreditFields
          form={form}
          isCreditLinePolicyDisabled={isCreditLinePolicyDisabled}
          selectedCurrency={selectedCurrency}
          persistedPhaseFieldsLocked={persistedPhaseFieldsLocked}
          creditLinePolicy={creditLinePolicy}
        />

        <TimingAndTrialFields
          form={form}
          isScheduleMode={isScheduleMode}
          persistedPhaseFieldsLocked={persistedPhaseFieldsLocked}
          isReadOnlyMode={isReadOnlyMode}
          hasSelectedPlanVersion={Boolean(selectedPlanVersion)}
          trialUnitLabel={trialUnitLabel}
          whenToChangeOptions={whenToChangeOptions}
        />

        <PaymentMethodSection
          form={form}
          isReadOnlyMode={isReadOnlyMode}
          paymentMethodRequired={paymentMethodRequired}
          paymentProvider={paymentProviderValue}
        />

        <ConfigItemsSection
          form={form}
          persistedPhaseFieldsLocked={persistedPhaseFieldsLocked}
          isReadOnlyMode={isReadOnlyMode}
          planVersionOptions={planVersionOptions}
          isLoading={isLoading}
        />

        <SubscriptionPhaseFormActions
          isReadOnlyMode={isReadOnlyMode}
          isSubmitting={form.formState.isSubmitting}
          isScheduleMode={isScheduleMode}
          editMode={editMode}
          whenToChange={whenToChange}
          onSubmit={() => form.handleSubmit(onSubmitForm)()}
        />
      </form>
    </Form>
  )
}

function PlanAndProviderFields<TFieldValues extends SubscriptionPhaseFieldValues>({
  form,
  persistedPhaseFieldsLocked,
  isReadOnlyMode,
  workspaceSlug,
  projectSlug,
  planVersionOptions,
  selectedPlanVersionFallback,
  isLoading,
}: {
  form: UseFormReturn<TFieldValues>
  persistedPhaseFieldsLocked: boolean
  isReadOnlyMode: boolean
  workspaceSlug: string
  projectSlug: string
  planVersionOptions: PlanVersionOptions
  selectedPlanVersionFallback: SubscriptionPhaseFormDefaultValues["planVersion"]
  isLoading?: boolean
}) {
  return (
    <>
      <SelectPlanFormField
        form={form}
        isDisabled={persistedPhaseFieldsLocked || isReadOnlyMode}
        planVersions={planVersionOptions}
        selectedPlanVersionFallback={selectedPlanVersionFallback}
        isLoading={isLoading}
      />

      <PaymentProviderFormField
        form={form}
        isDisabled={true}
        workspaceSlug={workspaceSlug}
        projectSlug={projectSlug}
      />
    </>
  )
}

function UsageCreditFields<TFieldValues extends SubscriptionPhaseFieldValues>({
  form,
  isCreditLinePolicyDisabled,
  selectedCurrency,
  persistedPhaseFieldsLocked,
  creditLinePolicy,
}: {
  form: UseFormReturn<TFieldValues>
  isCreditLinePolicyDisabled: boolean
  selectedCurrency: string
  persistedPhaseFieldsLocked: boolean
  creditLinePolicy?: CreditLinePolicy
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FormField
        control={form.control}
        name={"creditLinePolicy" as FieldPath<TFieldValues>}
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
                  form.setValue(
                    "creditLineAmount" as FieldPath<TFieldValues>,
                    null as PathValue<TFieldValues, FieldPath<TFieldValues>>
                  )
                }
              }}
              value={(field.value as CreditLinePolicy | undefined) ?? "uncapped"}
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
        name={"creditLineAmount" as FieldPath<TFieldValues>}
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
  )
}

function TimingAndTrialFields<TFieldValues extends SubscriptionPhaseFieldValues>({
  form,
  isScheduleMode,
  persistedPhaseFieldsLocked,
  isReadOnlyMode,
  hasSelectedPlanVersion,
  trialUnitLabel,
  whenToChangeOptions,
}: {
  form: UseFormReturn<TFieldValues>
  isScheduleMode: boolean
  persistedPhaseFieldsLocked: boolean
  isReadOnlyMode: boolean
  hasSelectedPlanVersion: boolean
  trialUnitLabel: string
  whenToChangeOptions: WhenToChangeOption[]
}) {
  return (
    <div className="flex flex-col items-center justify-start gap-4 lg:flex-row">
      {isScheduleMode ? (
        <FormField
          control={form.control}
          name={"whenToChange" as FieldPath<TFieldValues>}
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
              <Select
                onValueChange={field.onChange}
                value={(field.value as string | undefined) ?? "end_of_cycle"}
              >
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
  )
}

function PaymentMethodSection<TFieldValues extends SubscriptionPhaseFieldValues>({
  form,
  isReadOnlyMode,
  paymentMethodRequired,
  paymentProvider,
}: {
  form: UseFormReturn<TFieldValues>
  isReadOnlyMode: boolean
  paymentMethodRequired?: boolean
  paymentProvider?: PaymentProvider
}) {
  if (!paymentProvider || !paymentMethodRequired) {
    return null
  }

  return (
    <PaymentMethodsFormField
      form={form}
      withSeparator
      isDisabled={isReadOnlyMode}
      paymentProvider={paymentProvider}
      paymentProviderRequired={paymentMethodRequired}
    />
  )
}

function ConfigItemsSection<TFieldValues extends SubscriptionPhaseFieldValues>({
  form,
  persistedPhaseFieldsLocked,
  isReadOnlyMode,
  planVersionOptions,
  isLoading,
}: {
  form: UseFormReturn<TFieldValues>
  persistedPhaseFieldsLocked: boolean
  isReadOnlyMode: boolean
  planVersionOptions: PlanVersionOptions
  isLoading?: boolean
}) {
  return (
    <ConfigItemsFormField
      form={form}
      withSeparator
      isDisabled={persistedPhaseFieldsLocked || isReadOnlyMode}
      planVersions={planVersionOptions}
      isLoading={isLoading}
      withFeatureDetails
    />
  )
}

function SubscriptionPhaseFormActions({
  isReadOnlyMode,
  isSubmitting,
  isScheduleMode,
  editMode,
  whenToChange,
  onSubmit,
}: {
  isReadOnlyMode: boolean
  isSubmitting: boolean
  isScheduleMode: boolean
  editMode: boolean
  whenToChange?: string
  onSubmit: () => void
}) {
  if (isReadOnlyMode) {
    return null
  }

  return (
    <div className="mt-8 flex justify-end gap-4">
      <SubmitButton
        onClick={onSubmit}
        isSubmitting={isSubmitting}
        isDisabled={isSubmitting}
        label={getSubmitLabel({ isScheduleMode, whenToChange, editMode })}
        withConfirmation={isScheduleMode}
        confirmationMessage="Are you sure you want to add this phase? The current phase will be closed according to the selected timing."
      />
    </div>
  )
}

function getSubmitLabel({
  isScheduleMode,
  whenToChange,
  editMode,
}: {
  isScheduleMode: boolean
  whenToChange?: string
  editMode: boolean
}) {
  if (isScheduleMode) {
    return whenToChange === "immediately" ? "Change now" : "Add phase"
  }

  return editMode ? "Update" : "Create"
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

function getCreditLineAmountHelpText(
  fieldsLocked: boolean,
  creditLinePolicy: CreditLinePolicy | undefined
): string {
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
