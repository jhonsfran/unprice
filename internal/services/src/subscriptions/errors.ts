import { BaseError } from "@unprice/error"
import type { DomainErrorKind } from "../domain-error-kind"

export const subscriptionErrorCodes = [
  "SUBSCRIPTION_BUSY",
  "SUBSCRIPTION_NOT_FOUND",
  "SUBSCRIPTION_NOT_ACTIVE",
  "PLAN_VERSION_NOT_FOUND",
  "PLAN_VERSION_NOT_PUBLISHED",
  "PLAN_VERSION_NOT_ACTIVE",
  "PLAN_VERSION_FEATURES_MISSING",
  "PAYMENT_METHOD_REQUIRED",
  "PHASE_NOT_FOUND",
  "PHASE_START_DATE_LOCKED",
  "PHASE_START_DATE_INVALID",
  "PHASE_END_DATE_INVALID",
  "PHASE_ACTIVE_OR_PAST",
  "PHASE_OVERLAP",
  "PHASE_NOT_CONSECUTIVE",
  "PAYMENT_PROVIDER_UNAVAILABLE",
  "SUBSCRIPTION_OPERATION_FAILED",
] as const

export type SubscriptionErrorCode = (typeof subscriptionErrorCodes)[number]

export const subscriptionErrorKinds: Record<SubscriptionErrorCode, DomainErrorKind> = {
  SUBSCRIPTION_BUSY: "conflict",
  SUBSCRIPTION_OPERATION_FAILED: "internal",
  SUBSCRIPTION_NOT_FOUND: "precondition",
  SUBSCRIPTION_NOT_ACTIVE: "precondition",
  PLAN_VERSION_NOT_FOUND: "precondition",
  PLAN_VERSION_NOT_PUBLISHED: "precondition",
  PLAN_VERSION_NOT_ACTIVE: "precondition",
  PLAN_VERSION_FEATURES_MISSING: "precondition",
  PAYMENT_METHOD_REQUIRED: "precondition",
  PHASE_NOT_FOUND: "precondition",
  PHASE_START_DATE_LOCKED: "precondition",
  PHASE_START_DATE_INVALID: "precondition",
  PHASE_END_DATE_INVALID: "precondition",
  PHASE_ACTIVE_OR_PAST: "precondition",
  PHASE_OVERLAP: "precondition",
  PHASE_NOT_CONSECUTIVE: "precondition",
  PAYMENT_PROVIDER_UNAVAILABLE: "precondition",
}

export class UnPriceCalculationError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceCalculationError.name

  constructor({ message }: { message: string }) {
    super({
      message: `Failed to calculate price: ${message}`,
    })
  }
}

export class UnPriceSubscriptionError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly code: SubscriptionErrorCode
  public readonly retry = false
  public readonly name = UnPriceSubscriptionError.name

  constructor({
    code,
    message,
    context,
  }: {
    code: SubscriptionErrorCode
    message: string
    context?: Record<string, unknown>
  }) {
    super({
      message: `${message}`,
      context,
    })
    this.code = code
  }
}

export class UnPriceMachineError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceMachineError.name
  public readonly kind: DomainErrorKind

  constructor({ message, kind = "internal" }: { message: string; kind?: DomainErrorKind }) {
    super({
      message,
    })
    this.kind = kind
  }
}
