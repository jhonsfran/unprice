import { sha256HexSync } from "@unprice/db/utils"
import { currencySchema } from "@unprice/db/validators"
import type { Amount } from "@unprice/money"
import type { FundingResult } from "../../budgets"
import { DEFAULT_RESERVATION_POLICY, type ReservationOwner, type WalletService } from "../../wallet"
import type { BudgetAddress, BudgetWallet } from "./budget-client"
import { billingPeriodIdOf } from "./compile-payer-budget"

type WalletOps = Pick<
  WalletService,
  "createReservation" | "extendReservation" | "captureReservationUsage" | "releaseReservation"
>

/**
 * The wallet owner of one statement key's reservation. The wallet keeps one active reservation per
 * owner and period start, and its owner id holds 36 characters, so the id hashes the address.
 */
export function budgetReservationOwner(
  address: BudgetAddress,
  statementKey: string
): Extract<ReservationOwner, { type: "budget" }> {
  const id = sha256HexSync([address.projectId, address.key, statementKey].join("\n")).slice(0, 32)
  return { type: "budget", id }
}

/** Wallet amounts are numbers at the ledger scale; a budget's are bigints at the same scale. */
function walletAmount(amount: Amount): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${amount} exceeds a wallet amount`)
  return Number(amount)
}

/**
 * Runs funding intents against `WalletService`. A reserve opens the key's reservation (the wallet
 * hands back the active one on a replay) or extends it under the intent's `seq`; a close captures
 * each statement's amount, under capture seqs 1..n of that reservation, and releases the rest.
 * Every call carries only the intent's persisted fields, so a replay sends the same payload.
 */
export function walletFunding(wallet: WalletOps): BudgetWallet {
  return {
    async run(address, work): Promise<FundingResult> {
      const { intent, reservationId, statementKey } = work
      const currency = currencySchema.parse(work.currency)
      const base = { projectId: address.projectId, customerId: work.customerId, currency }
      const metadata = { budget_key: address.key, statement_key: statementKey }

      if (intent.kind === "reserve") {
        const requestedAmount = walletAmount(intent.amount)
        const effectiveAt = new Date(intent.at)
        if (reservationId === null) {
          const owner = budgetReservationOwner(address, statementKey)
          const created = await wallet.createReservation({
            ...base,
            entitlementId: null,
            owner,
            requestedAmount,
            refillThresholdBps: DEFAULT_RESERVATION_POLICY.refillThresholdBps,
            refillChunkAmount: 0,
            periodStartAt: new Date(intent.periodStart),
            periodEndAt: new Date(intent.periodEnd),
            effectiveAt,
            metadata,
            idempotencyKey: `budget:${owner.id}:${intent.seq}`,
          })
          if (created.err) throw created.err
          const { allocationAmount } = created.val
          return {
            kind: "reserved",
            reservationId: created.val.reservationId,
            granted: BigInt(allocationAmount),
          }
        }
        const extended = await wallet.extendReservation({
          ...base,
          reservationId,
          flushSeq: intent.seq,
          requestedAmount,
          statementKey,
          effectiveAt,
          metadata,
        })
        if (extended.err) throw extended.err
        return { kind: "reserved", reservationId, granted: BigInt(extended.val.grantedAmount) }
      }

      if (reservationId === null) throw new Error(`close of ${statementKey} has no reservation`)
      for (const [index, capture] of intent.captures.entries()) {
        const captured = await wallet.captureReservationUsage({
          ...base,
          reservationId,
          flushSeq: index + 1,
          amount: walletAmount(capture.amount),
          statementKey,
          // The invoice matches a capture to its billing period, not to the statement's id.
          billingPeriodId: billingPeriodIdOf(capture.periodId),
          kind: "usage",
          metadata: { ...metadata, statement_period_id: capture.periodId },
        })
        if (captured.err) throw captured.err
      }
      const released = await wallet.releaseReservation({
        ...base,
        reservationId,
        closeReason: "period_close",
        idempotencyKey: `release:${reservationId}:period_close`,
        metadata,
      })
      if (released.err) throw released.err
      return { kind: "closed" }
    },
  }
}
