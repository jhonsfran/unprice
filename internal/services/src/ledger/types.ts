import type { LedgerSettlementStatus, LedgerSettlementType } from "@unprice/db/validators"

export type LedgerState = {
  balanceMinor: bigint
  entryCount: number
}

export type LedgerEntryForFold = {
  signedAmountMinor: bigint
}

export type SettlementState = {
  id: string
  status: LedgerSettlementStatus
  type: LedgerSettlementType
  totalSettledMinor: bigint
  lineCount: number
  confirmedAt: number | null
  reversedAt: number | null
  reversalReason: string | null
}

export type NewLedgerEntry = {
  entryType: "debit" | "credit"
  amountMinor: bigint
  signedAmountMinor: bigint
  balanceAfterMinor: bigint
}

export type StatusTransition = {
  from: LedgerSettlementStatus
  to: LedgerSettlementStatus
}

export type ReversalPlan = {
  from: LedgerSettlementStatus
  to: "reversed"
  reason: string
  totalAmountMinor: bigint
}
