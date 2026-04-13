import { BaseError } from "@unprice/error"

export class UnPriceLedgerError extends BaseError<{ context?: Record<string, unknown> }> {
  public readonly retry = false
  public readonly name = UnPriceLedgerError.name

  constructor({ message, context }: { message: string; context?: Record<string, unknown> }) {
    super({
      message: `${message}`,
      context,
    })
  }
}

/**
 * Canonical error codes for the ledger domain.
 *
 * LEDGER_*            — entry / balance errors
 * SETTLEMENT_*        — settlement state-machine errors
 */
export type LedgerErrorCode =
  | "LEDGER_INVALID_AMOUNT"
  | "LEDGER_SOURCE_IDENTITY_REQUIRED"
  | "LEDGER_NOT_FOUND"
  | "LEDGER_ENTRY_UPSERT_FAILED"
  | "LEDGER_POST_ENTRY_FAILED"
  | "LEDGER_GET_UNSETTLED_ENTRIES_FAILED"
  | "LEDGER_GET_ENTRIES_BY_JOURNAL_FAILED"
  | "LEDGER_RECONCILE_FAILED"
  | "SETTLEMENT_NOT_FOUND"
  | "SETTLEMENT_INVALID_TRANSITION"
  | "SETTLEMENT_CREATE_FAILED"
  | "SETTLEMENT_CONFIRM_FAILED"
  | "SETTLEMENT_REVERSE_FAILED"
  | "ENTRIES_MIXED_LEDGERS"
