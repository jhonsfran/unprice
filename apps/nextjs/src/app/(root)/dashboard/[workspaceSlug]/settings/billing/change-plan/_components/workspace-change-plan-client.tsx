"use client"

import { useMutation } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Button } from "@unprice/ui/button"
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

type UpgradeOptions = RouterOutputs["workspaces"]["getUpgradeOptions"]
type UpgradeOption = UpgradeOptions["options"][number]
type WhenToChange = "immediately" | "end_of_cycle"

const TIMING_LABELS: Record<WhenToChange, string> = {
  immediately: "Immediately",
  end_of_cycle: "End of current cycle",
}

const PAYMENT_PROVIDER_LABELS: Record<PaymentProvider, string> = {
  sandbox: "Sandbox",
  square: "Square",
  stripe: "Stripe",
}

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
  const billingUrl = `/${workspaceSlug}/settings/billing`
  const initialSelectablePlanId = useMemo(
    () =>
      upgradeOptions.options.find(
        (option) =>
          option.planVersion.id === initialTargetPlanVersionId &&
          option.isAvailable &&
          !option.isCurrent
      )?.planVersion.id ?? null,
    [initialTargetPlanVersionId, upgradeOptions.options]
  )
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(initialSelectablePlanId)
  const [whenToChange, setWhenToChange] = useState<WhenToChange>("immediately")
  const [paymentSetup, setPaymentSetup] = useState<{
    paymentProvider: PaymentProvider
    message: string
  } | null>(null)

  const selectedOption = useMemo(
    () => upgradeOptions.options.find((option) => option.planVersion.id === selectedPlanId) ?? null,
    [selectedPlanId, upgradeOptions.options]
  )

  const changePlan = useMutation(
    trpc.workspaces.changePlan.mutationOptions({
      onSuccess: (result) => {
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
        router.push(billingUrl)
        router.refresh()
      },
      onError: (error) => {
        toast.error("Plan change failed", {
          description: error.message,
        })
      },
    })
  )

  const handleSelectPlan = (option: UpgradeOption) => {
    setSelectedPlanId(option.planVersion.id)
    setPaymentSetup(null)
  }

  const handleSubmit = () => {
    if (!selectedOption || selectedOption.isCurrent || !selectedOption.isAvailable) return

    changePlan.mutate({
      workspaceSlug,
      targetPlanVersionId: selectedOption.planVersion.id,
      whenToChange,
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {showFeatureBlockContext && (
        <Alert variant="info">
          <AlertTitle>Upgrade for this feature</AlertTitle>
          <AlertDescription>
            Choose a plan that includes the feature you were trying to use.
          </AlertDescription>
        </Alert>
      )}

      {upgradeOptions.options.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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

      {selectedOption && !selectedOption.isCurrent && selectedOption.isAvailable && (
        <section className="rounded-md border border-border/60 bg-card/70">
          <div className="flex flex-col gap-4 border-border/60 border-b px-4 py-4">
            <div className="flex flex-col gap-1">
              <h2 className="font-semibold text-base">Review plan change</h2>
              <p className="text-muted-foreground text-sm">
                Confirm the target plan and timing before applying this workspace billing change.
              </p>
            </div>

            <dl className="grid gap-3 text-sm md:grid-cols-3">
              <ReviewFact label="Selected plan" value={selectedOption.planVersion.plan.title} />
              <ReviewFact
                label="Payment provider"
                value={formatPaymentProvider(selectedOption.paymentProvider)}
              />
              <ReviewFact label="Timing" value={TIMING_LABELS[whenToChange]} />
            </dl>
          </div>

          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="flex flex-col gap-2">
              <p className="font-medium text-sm">Change timing</p>
              <Tabs
                value={whenToChange}
                onValueChange={(value) => setWhenToChange(value as WhenToChange)}
              >
                <TabsList variant="solid" className="grid w-full grid-cols-2 sm:w-auto">
                  <TabsTrigger value="immediately">Immediately</TabsTrigger>
                  <TabsTrigger value="end_of_cycle">End of current cycle</TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-muted-foreground text-xs">
                {whenToChange === "immediately"
                  ? "The plan changes now and the current phase closes immediately."
                  : getEndOfCycleDescription(upgradeOptions.currentCycleEndAt)}
              </p>
            </div>

            {paymentSetup && (
              <Alert variant="info">
                <AlertTitle>Payment method required</AlertTitle>
                <AlertDescription>
                  <div className="flex flex-col gap-3">
                    <p>{paymentSetup.message}</p>
                    <PaymentMethodButton
                      customerId={upgradeOptions.customerId}
                      successUrl={currentUrl}
                      cancelUrl={currentUrl}
                      paymentProvider={paymentSetup.paymentProvider}
                      workspaceSlug={workspaceSlug}
                      hasPaymentMethods={false}
                    />
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <SubmitButton
                label={
                  changePlan.isPending
                    ? "Applying change"
                    : whenToChange === "immediately"
                      ? "Change plan now"
                      : "Schedule change"
                }
                onClick={handleSubmit}
                isSubmitting={changePlan.isPending}
                isLoading={changePlan.isPending}
                isDisabled={changePlan.isPending}
                className="w-full sm:w-auto"
              />
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => {
                  setSelectedPlanId(null)
                  setPaymentSetup(null)
                }}
                disabled={changePlan.isPending}
              >
                Clear selection
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
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
  }
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

function ReviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 truncate font-medium text-sm">{value}</dd>
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
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp))
}

function formatPaymentProvider(paymentProvider: PaymentProvider): string {
  return PAYMENT_PROVIDER_LABELS[paymentProvider]
}
