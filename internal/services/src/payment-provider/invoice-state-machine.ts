import type { InvoiceStatus } from "@unprice/db/validators"
import type { InvoiceProviderStatus } from "./interface"

export type InvoicePaymentEvent =
  | "payment_succeeded"
  | "payment_failed"
  | "payment_reversed"
  | "payment_dispute_reversed"
  | "invoice_voided"
  | "invoice_uncollectible"

export type InvoiceSubscriptionOutcome = "success" | "failure"

export type InvoiceTransition =
  | {
      allowedFromStatuses: ReadonlyArray<InvoiceStatus>
      event: InvoicePaymentEvent
      nextStatus: InvoiceStatus
      settleWallet: boolean
      subscriptionOutcome: InvoiceSubscriptionOutcome
    }
  | {
      event: "noop"
      reason: "provider_open" | "already_applied" | "disallowed"
    }

const PAYMENT_SUCCEEDED_FROM: ReadonlyArray<InvoiceStatus> = [
  "draft",
  "waiting",
  "unpaid",
  "failed",
]
const PAYMENT_DISPUTE_REVERSED_FROM: ReadonlyArray<InvoiceStatus> = ["unpaid", "failed"]
const PAYMENT_FAILED_FROM: ReadonlyArray<InvoiceStatus> = ["draft", "waiting", "unpaid", "failed"]
const PAYMENT_REVERSED_FROM: ReadonlyArray<InvoiceStatus> = ["paid"]
const INVOICE_VOIDED_FROM: ReadonlyArray<InvoiceStatus> = ["draft", "waiting", "unpaid", "failed"]

const TRANSITIONS: Record<
  InvoicePaymentEvent,
  {
    allowedFromStatuses: ReadonlyArray<InvoiceStatus>
    nextStatus: InvoiceStatus
    settleWallet: boolean
    subscriptionOutcome: InvoiceSubscriptionOutcome
  }
> = {
  payment_succeeded: {
    allowedFromStatuses: PAYMENT_SUCCEEDED_FROM,
    nextStatus: "paid",
    settleWallet: true,
    subscriptionOutcome: "success",
  },
  payment_dispute_reversed: {
    allowedFromStatuses: PAYMENT_DISPUTE_REVERSED_FROM,
    nextStatus: "paid",
    settleWallet: true,
    subscriptionOutcome: "success",
  },
  payment_failed: {
    allowedFromStatuses: PAYMENT_FAILED_FROM,
    nextStatus: "unpaid",
    settleWallet: false,
    subscriptionOutcome: "failure",
  },
  payment_reversed: {
    allowedFromStatuses: PAYMENT_REVERSED_FROM,
    nextStatus: "failed",
    settleWallet: false,
    subscriptionOutcome: "failure",
  },
  invoice_uncollectible: {
    allowedFromStatuses: PAYMENT_FAILED_FROM,
    nextStatus: "failed",
    settleWallet: false,
    subscriptionOutcome: "failure",
  },
  invoice_voided: {
    allowedFromStatuses: INVOICE_VOIDED_FROM,
    nextStatus: "void",
    settleWallet: false,
    subscriptionOutcome: "success",
  },
}

export function providerStatusToInvoiceEvent(
  status: InvoiceProviderStatus | null
): InvoicePaymentEvent | "noop" {
  switch (status) {
    case "paid":
      return "payment_succeeded"
    case "void":
      return "invoice_voided"
    case "uncollectible":
      return "invoice_uncollectible"
    default:
      return "noop"
  }
}

export function transitionInvoiceStatus({
  currentStatus,
  event,
}: {
  currentStatus: InvoiceStatus
  event: InvoicePaymentEvent | "noop"
}): InvoiceTransition {
  if (event === "noop") {
    return { event: "noop", reason: "provider_open" }
  }

  const transition = TRANSITIONS[event]

  if (currentStatus === transition.nextStatus && event !== "payment_failed") {
    return { event: "noop", reason: "already_applied" }
  }

  if (!transition.allowedFromStatuses.includes(currentStatus)) {
    return { event: "noop", reason: "disallowed" }
  }

  return {
    event,
    ...transition,
  }
}
