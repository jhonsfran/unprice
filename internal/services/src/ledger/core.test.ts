import { describe, expect, it } from "vitest"
import {
  decideConfirm,
  decideCredit,
  decideDebit,
  decideReverse,
  foldLedgerState,
  foldSettlementState,
} from "./core"
import type { LedgerEntryForFold, LedgerState, SettlementState } from "./types"

describe("foldLedgerState", () => {
  it("returns zero state for empty entries", () => {
    const state = foldLedgerState([])
    expect(state.balanceMinor).toBe(BigInt(0))
    expect(state.entryCount).toBe(0)
  })

  it("sums debits and credits correctly", () => {
    const entries: LedgerEntryForFold[] = [
      { signedAmountMinor: BigInt(1_230_000) },
      { signedAmountMinor: BigInt(5_000_000) },
      { signedAmountMinor: BigInt(-2_000_000) },
    ]
    const state = foldLedgerState(entries)
    expect(state.balanceMinor).toBe(BigInt(4_230_000))
    expect(state.entryCount).toBe(3)
  })

  it("preserves sub-cent precision at scale 6", () => {
    const entries: LedgerEntryForFold[] = [
      { signedAmountMinor: BigInt(3_000) },
      { signedAmountMinor: BigInt(3_000) },
    ]
    const state = foldLedgerState(entries)
    expect(state.balanceMinor).toBe(BigInt(6_000))
  })
})

describe("decideDebit", () => {
  const baseState: LedgerState = { balanceMinor: BigInt(0), entryCount: 0 }

  it("returns Ok with correct balanceAfterMinor for a valid debit", () => {
    const result = decideDebit({ amountMinor: BigInt(1_000_000) }, baseState)
    expect(result.err).toBeUndefined()
    expect(result.val?.amountMinor).toBe(BigInt(1_000_000))
    expect(result.val?.signedAmountMinor).toBe(BigInt(1_000_000))
    expect(result.val?.balanceAfterMinor).toBe(BigInt(1_000_000))
    expect(result.val?.entryType).toBe("debit")
  })

  it("accumulates correctly on top of existing balance", () => {
    const state: LedgerState = { balanceMinor: BigInt(5_000_000), entryCount: 2 }
    const result = decideDebit({ amountMinor: BigInt(1_230_000) }, state)
    expect(result.val?.balanceAfterMinor).toBe(BigInt(6_230_000))
  })

  it("rejects zero amount", () => {
    const result = decideDebit({ amountMinor: BigInt(0) }, baseState)
    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("LEDGER_INVALID_AMOUNT")
  })

  it("rejects negative amount", () => {
    const result = decideDebit({ amountMinor: BigInt(-100) }, baseState)
    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("LEDGER_INVALID_AMOUNT")
  })

  it("preserves sub-cent precision", () => {
    const result = decideDebit({ amountMinor: BigInt(1) }, baseState)
    expect(result.err).toBeUndefined()
    expect(result.val?.amountMinor).toBe(BigInt(1))
    expect(result.val?.balanceAfterMinor).toBe(BigInt(1))
  })
})

describe("decideCredit", () => {
  const baseState: LedgerState = { balanceMinor: BigInt(5_000_000), entryCount: 1 }

  it("returns Ok with negative signedAmountMinor", () => {
    const result = decideCredit({ amountMinor: BigInt(2_000_000) }, baseState)
    expect(result.err).toBeUndefined()
    expect(result.val?.entryType).toBe("credit")
    expect(result.val?.amountMinor).toBe(BigInt(2_000_000))
    expect(result.val?.signedAmountMinor).toBe(BigInt(-2_000_000))
    expect(result.val?.balanceAfterMinor).toBe(BigInt(3_000_000))
  })

  it("rejects zero amount", () => {
    const result = decideCredit({ amountMinor: BigInt(0) }, baseState)
    expect(result.err).toBeDefined()
  })
})

describe("decideConfirm", () => {
  const baseSettlement = {
    id: "lset_1",
    type: "invoice" as const,
    totalSettledMinor: BigInt(1_000_000),
    lineCount: 1,
    confirmedAt: null,
    reversedAt: null,
    reversalReason: null,
  }

  it("allows pending → confirmed", () => {
    const state: SettlementState = { ...baseSettlement, status: "pending" }
    const result = decideConfirm(state)
    expect(result.err).toBeUndefined()
    expect(result.val?.from).toBe("pending")
    expect(result.val?.to).toBe("confirmed")
  })

  it("rejects confirmed → confirmed", () => {
    const state: SettlementState = { ...baseSettlement, status: "confirmed" }
    const result = decideConfirm(state)
    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("SETTLEMENT_INVALID_TRANSITION")
  })

  it("rejects reversed → confirmed (terminal)", () => {
    const state: SettlementState = { ...baseSettlement, status: "reversed" }
    const result = decideConfirm(state)
    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("SETTLEMENT_INVALID_TRANSITION")
  })
})

describe("decideReverse", () => {
  const baseSettlement = {
    id: "lset_1",
    type: "invoice" as const,
    totalSettledMinor: BigInt(1_000_000),
    lineCount: 1,
    confirmedAt: null,
    reversedAt: null,
    reversalReason: null,
  }

  it("allows pending → reversed", () => {
    const state: SettlementState = { ...baseSettlement, status: "pending" }
    const result = decideReverse(state, "payment failed")
    expect(result.err).toBeUndefined()
    expect(result.val?.from).toBe("pending")
    expect(result.val?.to).toBe("reversed")
    expect(result.val?.reason).toBe("payment failed")
    expect(result.val?.totalAmountMinor).toBe(BigInt(1_000_000))
  })

  it("allows confirmed → reversed (chargeback)", () => {
    const state: SettlementState = { ...baseSettlement, status: "confirmed" }
    const result = decideReverse(state, "chargeback")
    expect(result.err).toBeUndefined()
    expect(result.val?.from).toBe("confirmed")
  })

  it("rejects reversed → reversed (terminal)", () => {
    const state: SettlementState = { ...baseSettlement, status: "reversed" }
    const result = decideReverse(state, "duplicate reversal")
    expect(result.err).toBeDefined()
    expect(result.err?.message).toBe("SETTLEMENT_INVALID_TRANSITION")
  })
})

describe("foldSettlementState", () => {
  it("computes total settled amount and line count", () => {
    const settlement = {
      id: "lset_1",
      status: "pending",
      type: "invoice",
      confirmedAt: null,
      reversedAt: null,
      reversalReason: null,
    }
    const lines = [{ amountMinor: BigInt(1_000_000) }, { amountMinor: BigInt(2_000_000) }]
    const state = foldSettlementState(settlement, lines)
    expect(state.totalSettledMinor).toBe(BigInt(3_000_000))
    expect(state.lineCount).toBe(2)
    expect(state.status).toBe("pending")
  })

  it("returns empty totals for no lines", () => {
    const settlement = {
      id: "lset_1",
      status: "confirmed",
      type: "invoice",
      confirmedAt: 1000,
      reversedAt: null,
      reversalReason: null,
    }
    const state = foldSettlementState(settlement, [])
    expect(state.totalSettledMinor).toBe(BigInt(0))
    expect(state.lineCount).toBe(0)
    expect(state.confirmedAt).toBe(1000)
  })
})
