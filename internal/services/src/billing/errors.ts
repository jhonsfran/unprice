import { BaseError } from "@unprice/error"
import type { DomainErrorKind } from "../domain-error-kind"

export const billingErrorCodes = [
  "SUBSCRIPTION_BUSY",
  "SUBSCRIPTION_NOT_FOUND",
  "SUBSCRIPTION_NOT_ACTIVE",
  "SUBSCRIPTION_PHASE_NOT_FOUND",
  "INVOICE_NOT_FOUND",
  "INVOICE_NOT_FINALIZED",
  "INVOICE_FAILED",
  "INVOICE_NOT_READY",
  "INVOICE_PROVIDER_ID_MISSING",
  "INVOICE_PAYMENT_METHOD_MISSING",
  "INVOICE_STATUS_UNSUPPORTED",
  "INVOICE_UPDATE_FAILED",
  "INVOICE_LINES_MISSING",
  "INVOICE_PROVIDER_ITEMS_ORPHANED",
  "PAYMENT_PROVIDER_UNAVAILABLE",
  "PAYMENT_PROVIDER_STATUS_FAILED",
  "PAYMENT_COLLECTION_FAILED",
  "PAYMENT_SETTLEMENT_FAILED",
  "BILLING_OPERATION_FAILED",
] as const

export type BillingErrorCode = (typeof billingErrorCodes)[number]

export const billingErrorKinds: Record<BillingErrorCode, DomainErrorKind> = {
  SUBSCRIPTION_BUSY: "conflict",
  SUBSCRIPTION_NOT_ACTIVE: "precondition",
  SUBSCRIPTION_NOT_FOUND: "internal",
  SUBSCRIPTION_PHASE_NOT_FOUND: "internal",
  INVOICE_NOT_FOUND: "internal",
  INVOICE_NOT_FINALIZED: "internal",
  INVOICE_FAILED: "internal",
  INVOICE_NOT_READY: "internal",
  INVOICE_PROVIDER_ID_MISSING: "internal",
  INVOICE_PAYMENT_METHOD_MISSING: "internal",
  INVOICE_STATUS_UNSUPPORTED: "internal",
  INVOICE_UPDATE_FAILED: "internal",
  INVOICE_LINES_MISSING: "internal",
  INVOICE_PROVIDER_ITEMS_ORPHANED: "internal",
  PAYMENT_PROVIDER_UNAVAILABLE: "internal",
  PAYMENT_PROVIDER_STATUS_FAILED: "internal",
  PAYMENT_COLLECTION_FAILED: "internal",
  PAYMENT_SETTLEMENT_FAILED: "internal",
  BILLING_OPERATION_FAILED: "internal",
}

export class UnPriceBillingError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly code: BillingErrorCode
  public readonly retry = false
  public readonly name = UnPriceBillingError.name

  constructor({
    code,
    message,
    context,
  }: {
    code: BillingErrorCode
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
