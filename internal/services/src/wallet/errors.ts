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
  | "WALLET_METADATA_REQUIRED"
  | "WALLET_LEDGER_FAILED"
  | "WALLET_GRANT_TRACKING_DRIFT"

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
