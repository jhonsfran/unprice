import type {
  InsertSubscriptionPhase,
  SubscriptionChangePlan,
  SubscriptionPhase,
  SubscriptionPhaseExtended,
} from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"

export type SubscriptionPhaseFormMode = "create" | "edit" | "view" | "schedule"

export type SubscriptionPhaseFormDefaultValues = (
  | InsertSubscriptionPhase
  | Partial<SubscriptionPhase>
  | SubscriptionChangePlan
) & {
  customerId?: string
  subscriptionId?: string
  currentPlanVersionId?: string
  currentCycleEndAt?: number
  timezone?: string
  planVersion?: SubscriptionPhaseExtended["planVersion"]
}

export type SubscriptionPhaseFormSubmitValue = (InsertSubscriptionPhase | SubscriptionPhase) & {
  planVersion?: SubscriptionPhaseExtended["planVersion"]
}

export type SubscriptionPhaseFormValue = InsertSubscriptionPhase &
  Partial<SubscriptionChangePlan> & {
    planVersion?: SubscriptionPhaseExtended["planVersion"]
  }

export type SubscriptionPhaseFieldValue = SubscriptionPhaseFormValue & {
  _id: string
}

export type SubscriptionPhasePlanVersionSummary = Pick<
  SubscriptionPhaseExtended["planVersion"],
  "billingConfig" | "currency" | "id" | "paymentMethodRequired" | "title" | "trialUnits" | "version"
>

export type PhaseTimingState = "active" | "future" | "past"

export function formatPhaseCreditLinePolicy(
  phase: Pick<InsertSubscriptionPhase, "creditLinePolicy" | "creditLineAmount">,
  currency: string
): string {
  if ((phase.creditLinePolicy ?? "uncapped") === "uncapped") {
    return "uncapped usage"
  }

  if (phase.creditLineAmount === null || phase.creditLineAmount === undefined) {
    return "derived usage cap"
  }

  return `${formatMoney(toDecimal(fromLedgerMinor(phase.creditLineAmount, currency)), currency)} cap`
}

export function getPhaseTimingState(
  phase: Pick<InsertSubscriptionPhase, "startAt" | "endAt">,
  now: number
): PhaseTimingState {
  if (phase.startAt > now) {
    return "future"
  }

  if (phase.endAt !== null && phase.endAt !== undefined && phase.endAt < now) {
    return "past"
  }

  return "active"
}

export function getPhaseSheetTitle(mode: SubscriptionPhaseFormMode): string {
  switch (mode) {
    case "schedule":
      return "Add phase"
    case "edit":
      return "Edit phase"
    case "view":
      return "Phase details"
    case "create":
      return "Add phase"
  }
}

export function getPhaseSheetDescription(mode: SubscriptionPhaseFormMode): string {
  switch (mode) {
    case "schedule":
      return "Choose the plan, timing, and phase settings for the next subscription phase."
    case "edit":
      return "Update the editable settings for this future phase."
    case "view":
      return "Review the saved phase configuration."
    case "create":
      return "Configure the subscription phase for the customer."
  }
}
