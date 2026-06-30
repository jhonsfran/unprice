import { BaseError } from "@unprice/error"

export type WalletErrorCode =
  | "WALLET_INVALID_AMOUNT"
  | "WALLET_INSUFFICIENT_FUNDS"
  | "WALLET_RESERVATION_NOT_FOUND"
  | "WALLET_RESERVATION_ALREADY_RECONCILED"
  | "WALLET_TOPUP_NOT_FOUND"
  | "WALLET_TOPUP_ALREADY_SETTLED"
  | "WALLET_GRANT_NOT_FOUND"
  | "WALLET_GRANT_ALREADY_EXPIRED"
  | "WALLET_GRANT_HAS_ACTIVE_RESERVATION"
  | "WALLET_IDEMPOTENCY_CONFLICT"
  | "WALLET_METADATA_REQUIRED"
  | "WALLET_MISSING_INVOICE_CONTEXT"
  | "WALLET_LEDGER_FAILED"
  | "WALLET_GRANT_TRACKING_DRIFT"
  | "WALLET_EMPTY"
  | "WALLET_INVALID_RESERVATION_OWNER"

export class UnPriceWalletError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceWalletError.name

  constructor({
    message,
    context,
  }: {
    message: WalletErrorCode
    context?: Record<string, unknown>
  }) {
    super({
      message,
      context,
    })
  }
}
