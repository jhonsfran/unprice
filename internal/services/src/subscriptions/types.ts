import type {
  Customer,
  Subscription,
  SubscriptionPhaseExtended,
  SubscriptionStatus,
} from "@unprice/db/validators"
import type { DomainErrorKind } from "../domain-error-kind"

export type SusbriptionMachineStatus =
  | SubscriptionStatus
  | "loading"
  | "error"
  | "success"
  | "restored"
  | "renewing" // the subscription is renewing
  | "invoicing" // the subscription is invoicing
  | "invoiced" // the subscription is invoiced, ready to be renewed

// State machine types
export interface SubscriptionContext {
  // Current time in milliseconds for the machine
  now: number
  subscriptionId: string
  projectId: string
  // Current subscription data
  subscription: Subscription
  customer: Customer
  paymentMethodId: string | null
  requiredPaymentMethod: boolean
  // Current active phase for convenience
  currentPhase: SubscriptionPhaseExtended | null
  error?: {
    message: string
    kind?: DomainErrorKind
  }
}

// Update the SubscriptionEvent type to include these events
export type SubscriptionEvent =
  | { type: "RENEW" }
  | { type: "RESTORE" }
  | { type: "PAYMENT_FAILURE"; invoiceId: string; error: string }
  | { type: "PAYMENT_SUCCESS"; invoiceId: string }
  | { type: "INVOICE_SUCCESS"; invoiceId: string }
  | { type: "INVOICE_FAILURE"; invoiceId: string; error: string }
  | { type: "INVOICE" }
  | { type: "ACTIVATE" }

export type SubscriptionGuards = {
  type:
    | "isTrialExpired"
    | "canRenew"
    | "hasValidPaymentMethod"
    | "canInvoice"
    | "isAlreadyRenewed"
    | "isAutoRenewEnabled"
    | "isAlreadyInvoiced"
    | "currentPhaseNull"
}

export type SubscriptionActions = {
  type: "logStateTransition" | "notifyCustomer" | "updateSubscription"
}

export type MachineTags = "subscription" | "machine" | "error" | "transition" | "loading" | "final"
