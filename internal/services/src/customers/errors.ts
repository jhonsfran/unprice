import type { z } from "zod"

import type { deniedReasonSchema } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"
import type { DomainErrorKind } from "../domain-error-kind"

export type DenyReason = z.infer<typeof deniedReasonSchema>

export const customerErrorKinds: Partial<Record<DenyReason, DomainErrorKind>> = {
  SUBSCRIPTION_NOT_ACTIVE: "precondition",
  PLAN_VERSION_NOT_PUBLISHED: "precondition",
  PLAN_VERSION_NOT_ACTIVE: "precondition",
  PLAN_VERSION_NOT_FOUND: "precondition",
  PAYMENT_PROVIDER_CONFIG_NOT_FOUND: "precondition",
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
