import { Err, Ok, type Result } from "@unprice/error"
import { UnPriceLedgerError } from "./errors"
import type {
  LedgerEntryForFold,
  LedgerState,
  NewLedgerEntry,
  ReversalPlan,
  SettlementState,
  StatusTransition,
} from "./types"

export function foldLedgerState(entries: LedgerEntryForFold[]): LedgerState {
  return entries.reduce(
    (state, entry) => ({
      balanceMinor: state.balanceMinor + entry.signedAmountMinor,
      entryCount: state.entryCount + 1,
    }),
    { balanceMinor: BigInt(0), entryCount: 0 }
  )
}

export function foldSettlementState(
  settlement: {
    id: string
    status: string
    type: string
    confirmedAt: number | null
    reversedAt: number | null
    reversalReason: string | null
  },
  lines: { amountMinor: bigint }[]
): SettlementState {
  return {
    id: settlement.id,
    status: settlement.status as SettlementState["status"],
    type: settlement.type as SettlementState["type"],
    totalSettledMinor: lines.reduce((sum, l) => sum + l.amountMinor, BigInt(0)),
    lineCount: lines.length,
    confirmedAt: settlement.confirmedAt,
    reversedAt: settlement.reversedAt,
    reversalReason: settlement.reversalReason,
  }
}

export function decideDebit(
  command: { amountMinor: bigint },
  state: LedgerState
): Result<NewLedgerEntry, UnPriceLedgerError> {
  if (command.amountMinor <= BigInt(0)) {
    return Err(new UnPriceLedgerError({ message: "LEDGER_INVALID_AMOUNT" }))
  }
  const balanceAfterMinor = state.balanceMinor + command.amountMinor
  return Ok({
    entryType: "debit" as const,
    amountMinor: command.amountMinor,
    signedAmountMinor: command.amountMinor,
    balanceAfterMinor,
  })
}

export function decideCredit(
  command: { amountMinor: bigint },
  state: LedgerState
): Result<NewLedgerEntry, UnPriceLedgerError> {
  if (command.amountMinor <= BigInt(0)) {
    return Err(new UnPriceLedgerError({ message: "LEDGER_INVALID_AMOUNT" }))
  }
  const signedAmountMinor = -command.amountMinor
  const balanceAfterMinor = state.balanceMinor + signedAmountMinor
  return Ok({
    entryType: "credit" as const,
    amountMinor: command.amountMinor,
    signedAmountMinor,
    balanceAfterMinor,
  })
}

export function decideConfirm(
  state: SettlementState
): Result<StatusTransition, UnPriceLedgerError> {
  if (state.status !== "pending") {
    return Err(new UnPriceLedgerError({ message: "SETTLEMENT_INVALID_TRANSITION" }))
  }
  return Ok({ from: "pending" as const, to: "confirmed" as const })
}

export function decideReverse(
  state: SettlementState,
  reason: string
): Result<ReversalPlan, UnPriceLedgerError> {
  if (state.status === "reversed") {
    return Err(new UnPriceLedgerError({ message: "SETTLEMENT_INVALID_TRANSITION" }))
  }
  return Ok({
    from: state.status,
    to: "reversed" as const,
    reason,
    totalAmountMinor: state.totalSettledMinor,
  })
}
