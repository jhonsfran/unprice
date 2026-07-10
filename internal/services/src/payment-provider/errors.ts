import { BaseError } from "@unprice/error"

export const paymentProviderErrorCodes = ["MISSING_PAYMENT_METHOD", "PROVIDER_ERROR"] as const

export type PaymentProviderErrorCode = (typeof paymentProviderErrorCodes)[number]

export class UnPricePaymentProviderError extends BaseError {
  public readonly retry = false
  public readonly name = UnPricePaymentProviderError.name
  public readonly code: PaymentProviderErrorCode

  constructor({
    code = "PROVIDER_ERROR",
    message,
  }: {
    code?: PaymentProviderErrorCode
    message: string
  }) {
    super({
      message: message ?? "",
    })
    this.code = code
  }
}

/**
 * A missing/absent default payment method is a recoverable precondition, not a
 * fatal error: callers surface it as "add a payment method" instead of failing.
 * Classify by the stable code, never by the human-readable message.
 */
export function isMissingPaymentMethodError(error: unknown): boolean {
  return error instanceof UnPricePaymentProviderError && error.code === "MISSING_PAYMENT_METHOD"
}
