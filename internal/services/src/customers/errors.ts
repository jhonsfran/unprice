import type { z } from "zod"

import type { deniedReasonSchema } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"
import type { DomainErrorKind } from "../domain-error-kind"

export type DenyReason = z.infer<typeof deniedReasonSchema>

export const customerErrorKinds: Partial<Record<DenyReason, DomainErrorKind>> = {
  PROJECT_DISABLED: "forbidden",
  CUSTOMER_DISABLED: "forbidden",
  CUSTOMER_NOT_FOUND: "not_found",
  CUSTOMER_SESSION_NOT_FOUND: "not_found",
  CUSTOMER_EXTERNAL_ID_CONFLICT: "conflict",
  SUBSCRIPTION_NOT_FOUND: "precondition",
  SUBSCRIPTION_NOT_ACTIVE: "precondition",
  NO_DEFAULT_PLAN_FOUND: "precondition",
  PLAN_VERSION_NOT_PUBLISHED: "precondition",
  PLAN_VERSION_NOT_ACTIVE: "precondition",
  PLAN_VERSION_NOT_FOUND: "precondition",
  PAYMENT_PROVIDER_CONFIG_NOT_FOUND: "precondition",
  BILLING_INTERVAL_MISMATCH: "precondition",
  CURRENCY_MISMATCH: "precondition",
}

export class UnPriceCustomerError extends BaseError<{ customerId?: string }> {
  public readonly retry = false
  public readonly name = UnPriceCustomerError.name
  public readonly code: DenyReason

  constructor({
    code,
    customerId,
    message,
  }: {
    code: DenyReason
    customerId?: string
    message?: string
  }) {
    super({
      message: message ?? "",
      context: {
        customerId,
      },
    })
    this.code = code
  }
}
