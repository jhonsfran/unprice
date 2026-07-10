import { SchemaError } from "@unprice/error"
import { UnPriceBillingError, billingErrorKinds } from "./billing/errors"
import { UnPriceCustomerError, customerErrorKinds } from "./customers/errors"
import {
  UnPriceMachineError,
  UnPriceSubscriptionError,
  subscriptionErrorKinds,
} from "./subscriptions/errors"
import { SubscriptionChangePhasePlanError } from "./use-cases/subscription/change-plan"
import { WorkspaceChangePlanError } from "./use-cases/workspace/change-plan"
import { GetWorkspaceUpgradeOptionsError } from "./use-cases/workspace/get-upgrade-options"

export type DomainErrorKind = "bad_request" | "precondition" | "conflict" | "not_found" | "internal"

// Returns the kind for a known domain error, or null when the error is unknown
// (caller maps null -> internal). SchemaError -> bad_request is handled here too.
export function resolveDomainErrorKind(error: unknown): DomainErrorKind | null {
  if (error instanceof SchemaError) return "bad_request"
  if (error instanceof UnPriceSubscriptionError) return subscriptionErrorKinds[error.code]
  if (error instanceof UnPriceBillingError) return billingErrorKinds[error.code]
  if (error instanceof UnPriceCustomerError) return customerErrorKinds[error.code] ?? "internal"
  if (error instanceof UnPriceMachineError) return error.kind
  if (error instanceof WorkspaceChangePlanError) return error.kind
  if (error instanceof SubscriptionChangePhasePlanError) return error.kind
  if (error instanceof GetWorkspaceUpgradeOptionsError) return error.kind
  return null
}
