"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@unprice/ui/alert-dialog"
import { Tabs, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import {
  PlanVersionPricingCard,
  type PlanVersionPricingCardAction,
} from "~/components/billing/plan-version-pricing-card"
import { PaymentMethodButton } from "~/components/forms/payment-method-form"
import { SubmitButton } from "~/components/submit-button"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { getPlanGridClassName } from "./plan-grid"

type UpgradeOptions = RouterOutputs["workspaces"]["getUpgradeOptions"]
type UpgradeOption = UpgradeOptions["options"][number]
type WhenToChange = "immediately" | "end_of_cycle"
type PaymentMethodPrompt = {
  paymentProvider: PaymentProvider
  message: string
}

const TIMING_LABELS: Record<WhenToChange, string> = {
  immediately: "Immediately",
  end_of_cycle: "End of current cycle",
}

const MISSING_PAYMENT_METHOD_MESSAGE = "Add a payment method before changing to this plan."

const PAYMENT_PROVIDER_LABELS: Record<PaymentProvider, string> = {
  sandbox: "Sandbox",
  square: "Square",
  stripe: "Stripe",
}

const BILLING_CYCLE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export function WorkspaceChangePlanClient({
  workspaceSlug,
  upgradeOptions,
  showFeatureBlockContext,
  initialTargetPlanVersionId,
  currentUrl,
}: {
  workspaceSlug: string
  upgradeOptions: UpgradeOptions
  showFeatureBlockContext?: boolean
  initialTargetPlanVersionId?: string
  currentUrl: string
}) {
  const router = useRouter()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const billingUrl = `/${workspaceSlug}/settings/billing`
  const hasCurrentCycleEnd = upgradeOptions.currentCycleEndAt !== null
  const initialSelectablePlanId = useMemo(
    () =>
      upgradeOptions.options.find(
        (option) =>
          option.planVersion.id === initialTargetPlanVersionId &&
          (option.isAvailable || isMissingPaymentMethodOption(option)) &&
          !option.isCurrent
      )?.planVersion.id ?? null,
    [initialTargetPlanVersionId, upgradeOptions.options]
  )
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(initialSelectablePlanId)
  const [confirmOpen, setConfirmOpen] = useState(initialSelectablePlanId !== null)
  const [whenToChange, setWhenToChange] = useState<WhenToChange>("immediately")
  const effectiveWhenToChange = hasCurrentCycleEnd ? whenToChange : "immediately"
  const [paymentSetup, setPaymentSetup] = useState<PaymentMethodPrompt | null>(null)

  const selectedOption = useMemo(
    () => upgradeOptions.options.find((option) => option.planVersion.id === selectedPlanId) ?? null,
    [selectedPlanId, upgradeOptions.options]
  )
  const selectedNeedsPaymentMethod = selectedOption
    ? isMissingPaymentMethodOption(selectedOption)
    : false
  const showReviewSection =
    !!selectedOption &&
    !selectedOption.isCurrent &&
    (selectedOption.isAvailable || selectedNeedsPaymentMethod)
  const paymentMethodPrompt =
    selectedOption && selectedNeedsPaymentMethod
      ? {
          paymentProvider: selectedOption.paymentProvider,
          message: selectedOption.unavailableReason ?? MISSING_PAYMENT_METHOD_MESSAGE,
        }
      : paymentSetup

  const changePlan = useMutation(
    trpc.workspaces.changePlan.mutationOptions({
      onSuccess: async (result) => {
        if (result.status === "requires_payment_method") {
          setPaymentSetup({
            paymentProvider: result.paymentProvider,
            message: result.message,
          })
          return
        }

        toast.success(result.status === "changed" ? "Plan changed" : "Plan change scheduled", {
          description:
            result.status === "changed"
              ? "Your workspace plan has been updated."
              : "Your workspace plan change is scheduled for the end of the current cycle.",
        })
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.workspaces.listWorkspacesByActiveUser.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.projects.listByActiveWorkspace.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.projects.listByWorkspace.queryKey({ workspaceSlug }),
          }),
        ])
        router.push(billingUrl)
        router.refresh()
      },
    })
  )

  const handleSelectPlan = (option: UpgradeOption) => {
    setSelectedPlanId(option.planVersion.id)
    setPaymentSetup(null)
    setConfirmOpen(true)
  }

  const handleSubmit = () => {
    if (changePlan.isPending) return
    if (!selectedOption || selectedOption.isCurrent) return
    if (selectedNeedsPaymentMethod || !selectedOption.isAvailable) return

    changePlan.mutate({
      workspaceSlug,
      targetPlanVersionId: selectedOption.planVersion.id,
      whenToChange: effectiveWhenToChange,
    })
  }

  const handleConfirmOpenChange = (open: boolean) => {
    if (!open && changePlan.isPending) return

    setConfirmOpen(open)

    if (!open) {
      setSelectedPlanId(null)
      setPaymentSetup(null)
    }
  }

  return (
    <div className="flex flex-col gap-8 pt-3 md:gap-10 md:pt-5">
      {showFeatureBlockContext && (
        <Alert variant="info">
          <AlertTitle>Upgrade for this feature</AlertTitle>
          <AlertDescription>
            Choose a plan that includes the feature you were trying to use.
          </AlertDescription>
        </Alert>
      )}

      {upgradeOptions.options.length > 0 ? (
        <section className={getPlanGridClassName(upgradeOptions.options.length)}>
          {upgradeOptions.options.map((option) => {
            const selected = option.planVersion.id === selectedPlanId

            return (
              <PlanVersionPricingCard
                key={option.planVersion.id}
                planVersion={option.planVersion}
                className="w-full"
                highlight={selected || option.isCurrent}
                action={getPlanAction(option, selected, () => handleSelectPlan(option))}
              />
            )
          })}
        </section>
      ) : (
        <Alert variant="info">
          <AlertTitle>No plans available</AlertTitle>
          <AlertDescription>
            There are no published plans available for this workspace right now.
          </AlertDescription>
        </Alert>
      )}

      <PlanChangeConfirmationDialog
        open={confirmOpen && showReviewSection}
        onOpenChange={handleConfirmOpenChange}
        selectedOption={selectedOption}
        selectedNeedsPaymentMethod={selectedNeedsPaymentMethod}
        paymentMethodPrompt={paymentMethodPrompt}
        currentUrl={currentUrl}
        workspaceSlug={workspaceSlug}
        customerId={upgradeOptions.customerId}
        hasCurrentCycleEnd={hasCurrentCycleEnd}
        currentCycleEndAt={upgradeOptions.currentCycleEndAt}
        effectiveWhenToChange={effectiveWhenToChange}
        onWhenToChange={setWhenToChange}
        onConfirm={handleSubmit}
        isPending={changePlan.isPending}
      />
    </div>
  )
}

function PlanChangeConfirmationDialog({
  open,
  onOpenChange,
  selectedOption,
  selectedNeedsPaymentMethod,
  paymentMethodPrompt,
  currentUrl,
  workspaceSlug,
  customerId,
  hasCurrentCycleEnd,
  currentCycleEndAt,
  effectiveWhenToChange,
  onWhenToChange,
  onConfirm,
  isPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedOption: UpgradeOption | null
  selectedNeedsPaymentMethod: boolean
  paymentMethodPrompt: PaymentMethodPrompt | null
  currentUrl: string
  workspaceSlug: string
  customerId: string
  hasCurrentCycleEnd: boolean
  currentCycleEndAt: number | null
  effectiveWhenToChange: WhenToChange
  onWhenToChange: (value: WhenToChange) => void
  onConfirm: () => void
  isPending: boolean
}) {
  if (!selectedOption) return null

  const submitLabel = isPending
    ? "Applying change"
    : effectiveWhenToChange === "immediately"
      ? "Change plan now"
      : "Schedule change"

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-[520px]">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {paymentMethodPrompt
              ? "Set up payment method"
              : `Change to ${selectedOption.planVersion.plan.title}`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {paymentMethodPrompt
              ? "This plan needs a payment method before the change can be applied."
              : "Confirm the target plan and timing before applying this workspace billing change."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          <PlanChangeSummary
            selectedOption={selectedOption}
            effectiveWhenToChange={effectiveWhenToChange}
          />

          {!paymentMethodPrompt && (
            <div className="flex flex-col gap-2">
              <p className="font-medium text-sm">Change timing</p>
              <Tabs
                value={effectiveWhenToChange}
                onValueChange={(value) => {
                  if (value === "end_of_cycle" && !hasCurrentCycleEnd) return

                  onWhenToChange(value as WhenToChange)
                }}
              >
                <TabsList variant="solid" className="grid w-full grid-cols-2">
                  <TabsTrigger value="immediately">Immediately</TabsTrigger>
                  <TabsTrigger value="end_of_cycle" disabled={!hasCurrentCycleEnd}>
                    End of current cycle
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-muted-foreground text-xs">
                {effectiveWhenToChange === "immediately"
                  ? "The plan changes now and the current phase closes immediately."
                  : getEndOfCycleDescription(currentCycleEndAt)}
              </p>
              {!hasCurrentCycleEnd && (
                <p className="text-muted-foreground text-xs">
                  End-of-cycle scheduling is unavailable because this workspace has no current cycle
                  end.
                </p>
              )}
            </div>
          )}

          {paymentMethodPrompt && (
            <Alert variant="info">
              <AlertTitle>Payment method required</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-3">
                  <p>{paymentMethodPrompt.message}</p>
                  <PaymentMethodButton
                    customerId={customerId}
                    successUrl={currentUrl}
                    cancelUrl={currentUrl}
                    paymentProvider={paymentMethodPrompt.paymentProvider}
                    workspaceSlug={workspaceSlug}
                    hasPaymentMethods={false}
                  />
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          {!paymentMethodPrompt && (
            <SubmitButton
              label={submitLabel}
              onClick={onConfirm}
              isSubmitting={isPending}
              isLoading={isPending}
              isDisabled={isPending || selectedNeedsPaymentMethod}
              className="w-full sm:w-auto"
            />
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PlanChangeSummary({
  selectedOption,
  effectiveWhenToChange,
}: {
  selectedOption: UpgradeOption
  effectiveWhenToChange: WhenToChange
}) {
  return (
    <dl className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm">
      <SummaryRow label="Selected plan" value={selectedOption.planVersion.plan.title} />
      <SummaryRow
        label="Payment provider"
        value={formatPaymentProvider(selectedOption.paymentProvider)}
      />
      <SummaryRow label="Timing" value={TIMING_LABELS[effectiveWhenToChange]} />
    </dl>
  )
}

function getPlanAction(
  option: UpgradeOption,
  selected: boolean,
  onSelect: () => void
): PlanVersionPricingCardAction {
  if (option.isCurrent) {
    return { kind: "current", label: "Current plan" }
  }

  if (isMissingPaymentMethodOption(option)) {
    return {
      kind: "select",
      label: selected ? "Payment required" : "Set up payment",
      onSelect,
      selected,
    }
  }

  if (!option.isAvailable) {
    return {
      kind: "disabled",
      label: "Unavailable",
      reason: getUnavailableReason(option),
    }
  }

  return {
    kind: "select",
    label: selected ? "Selected" : "Select plan",
    onSelect,
    selected,
  }
}

function isMissingPaymentMethodOption(option: UpgradeOption): boolean {
  return (
    !option.isCurrent &&
    !option.isAvailable &&
    option.paymentMethodRequired &&
    !option.hasPaymentMethod &&
    (option.unavailableReason === null || isPaymentMethodReason(option.unavailableReason))
  )
}

function isPaymentMethodReason(reason: string): boolean {
  return reason.toLowerCase().includes("payment method")
}

function getUnavailableReason(option: UpgradeOption): string {
  if (option.unavailableReason) {
    return option.unavailableReason
  }

  if (option.paymentMethodRequired && !option.hasPaymentMethod) {
    return `Add a payment method for ${formatPaymentProvider(option.paymentProvider)} before changing to this plan.`
  }

  return "This plan is not available right now."
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr] sm:items-center">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  )
}

function getEndOfCycleDescription(currentCycleEndAt: number | null): string {
  if (!currentCycleEndAt) {
    return "The new plan starts when the current billing cycle ends."
  }

  return `The new plan starts on ${formatDate(currentCycleEndAt)}.`
}

function formatDate(timestamp: number): string {
  return BILLING_CYCLE_DATE_FORMAT.format(new Date(timestamp))
}

function formatPaymentProvider(paymentProvider: PaymentProvider): string {
  return PAYMENT_PROVIDER_LABELS[paymentProvider]
}
