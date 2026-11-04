import type { FundingResult, FundingWork } from "../../budgets"
import type { BudgetAddress, BudgetWallet } from "./budget-client"

/** One wallet call as the fake saw it. */
export type FakeWalletCall = Readonly<{
  kind: "reserve" | "close"
  statementKey: string
  seq: number
  reservationId: string | null
  amount: bigint
}>

/**
 * Test double for the payer's wallet: one balance, reservations by id, and every call in order.
 * A reserve grants what the balance has, up to the amount; a replayed `seq` answers what it
 * answered first, as the wallet's idempotency keys do. A close moves its captures out and returns
 * the rest of the allocation to the balance. `failNext` throws on the next call, after nothing.
 */
export class FakeWallet implements BudgetWallet {
  balance: bigint
  readonly calls: FakeWalletCall[] = []
  readonly reservations = new Map<
    string,
    { allocated: bigint; captured: bigint; closed: boolean }
  >()
  failNext = false
  private readonly answered = new Map<string, FundingResult>()

  constructor(balance = BigInt(0)) {
    this.balance = balance
  }

  async run(address: BudgetAddress, work: FundingWork): Promise<FundingResult> {
    const { intent, statementKey, reservationId } = work
    const amount =
      intent.kind === "reserve"
        ? intent.amount
        : intent.captures.reduce((sum, capture) => sum + capture.amount, BigInt(0))
    this.calls.push({ kind: intent.kind, statementKey, seq: intent.seq, reservationId, amount })
    if (this.failNext) {
      this.failNext = false
      throw new Error("wallet unavailable")
    }
    const replayKey = `${address.key}|${statementKey}|${intent.kind}|${intent.seq}`
    const replay = this.answered.get(replayKey)
    if (replay) return replay

    let result: FundingResult
    if (intent.kind === "reserve") {
      const granted = intent.amount < this.balance ? intent.amount : this.balance
      this.balance -= granted
      const id = reservationId ?? `res_${this.reservations.size + 1}`
      const reservation = this.reservations.get(id) ?? {
        allocated: BigInt(0),
        captured: BigInt(0),
        closed: false,
      }
      this.reservations.set(id, { ...reservation, allocated: reservation.allocated + granted })
      result = { kind: "reserved", reservationId: id, granted }
    } else {
      const reservation = reservationId ? this.reservations.get(reservationId) : undefined
      if (!reservationId || !reservation) throw new Error(`no reservation for ${statementKey}`)
      this.balance += reservation.allocated - amount
      this.reservations.set(reservationId, { ...reservation, captured: amount, closed: true })
      result = { kind: "closed" }
    }
    this.answered.set(replayKey, result)
    return result
  }
}
