import { BaseError } from "@unprice/error"

export type LedgerErrorCode =
  | "LEDGER_INVALID_AMOUNT"
  | "LEDGER_SOURCE_IDENTITY_REQUIRED"
  | "LEDGER_CURRENCY_MISMATCH"
  | "LEDGER_TRANSFER_FAILED"
  | "LEDGER_ACCOUNT_NOT_FOUND"
  | "LEDGER_BATCH_FAILED"
  | "LEDGER_GET_BALANCE_FAILED"
  | "LEDGER_GET_ENTRIES_FAILED"
  | "LEDGER_SEED_HOUSE_ACCOUNTS_FAILED"

export class UnPriceLedgerError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceLedgerError.name

  constructor({
    message,
    context,
  }: { message: LedgerErrorCode; context?: Record<string, unknown> }) {
    super({
      message,
      context,
    })
  }
}
