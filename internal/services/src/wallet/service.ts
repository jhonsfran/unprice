import { type Database, and, asc, eq, gt, isNull, or, sql } from "@unprice/db"
import {
  entitlementReservations,
  type EntitlementReservationDrainLeg,
  walletCredits,
  walletTopups,
} from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Currency, WalletCredit, WalletCreditSource } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"

import type { DbExecutor, Transaction } from "../deps"
import {
  type LedgerGateway,
  type LedgerSource,
  type LedgerTransferRequest,
  type PlatformFundingKind,
  customerAccountKeys,
  platformAccountKey,
} from "../ledger"
import { UnPriceLedgerError } from "../ledger"
import { toErrorContext } from "../utils/log-context"
import { UnPriceWalletError } from "./errors"

/**
 * Record of how a drain was funded — one leg per source sub-account. When
 * draining for a reservation or refill, `granted` drains first (FIFO by
 * grant expiry); `purchased` covers the remainder.
 */
export interface DrainLeg {
  source: "granted" | "purchased"
  amount: number
  grantId?: string
  grantSource?: WalletCreditSource
}

export interface WalletDeps {
  db: Database
  logger: Logger
  ledgerGateway: LedgerGateway
}

export interface WalletTransferInput {
  projectId: string
  customerId: string
  currency: Currency
  fromAccountKey: string
  toAccountKey: string
  amount: number
  metadata: Record<string, unknown>
  idempotencyKey: string
}

export interface CreateReservationInput {
  projectId: string
  customerId: string
  currency: Currency
  entitlementId: string
  requestedAmount: number
  refillThresholdBps: number
  refillChunkAmount: number
  periodStartAt: Date
  periodEndAt: Date
  idempotencyKey: string
}

export interface CreateReservationOutput {
  reservationId: string
  allocationAmount: number
  drainLegs: DrainLeg[]
  // Set to "active" when an existing active reservation row was found for
  // this (project, entitlement, period_start_at) tuple instead of a fresh
  // insert. The DO uses this to preserve flush bookkeeping (consumed,
  // flushed, flushSeq) on rehydration. Closed reservations are ignored
  // — the partial unique index lets us INSERT a fresh row alongside them.
  reused?: "active"
}

export interface FlushReservationInput {
  projectId: string
  customerId: string
  currency: Currency
  reservationId: string
  flushSeq: number
  flushAmount: number
  refillChunkAmount: number
  statementKey: string
  final: boolean
  sourceId?: string
}

export interface FlushReservationOutput {
  grantedAmount: number
  flushedAmount: number
  refundedAmount: number
  drainLegs: DrainLeg[]
}

export type AdjustSource = WalletCreditSource | "purchased"

export interface AdjustInput {
  projectId: string
  customerId: string
  currency: Currency
  signedAmount: number
  actorId: string
  reason: string
  source: AdjustSource
  idempotencyKey: string
  expiresAt?: Date
  metadata?: Record<string, unknown>
}

export interface AdjustOutput {
  clampedAmount: number
  unclampedRemainder: number
  grantId?: string
}

export interface SettleTopUpInput {
  projectId: string
  customerId: string
  currency: Currency
  providerSessionId: string
  paidAmount: number
  idempotencyKey: string
}

export interface SettleTopUpOutput {
  topupId: string
  ledgerTransferId: string
}

export interface SettleReceivableInput {
  projectId: string
  customerId: string
  currency: Currency
  paidAmount: number
  idempotencyKey: string
  metadata?: Record<string, unknown>
}

export interface SettleReceivableOutput {
  ledgerTransferId: string
}

export interface ExpireGrantInput {
  customerId: string
  projectId: string
  currency: Currency
  grantId: string
  amount: number
  source: WalletCreditSource
  idempotencyKey: string
}

export interface GetWalletStateInput {
  projectId: string
  customerId: string
}

export interface WalletBalances {
  purchased: number
  granted: number
  reserved: number
  consumed: number
}

export interface WalletStateOutput {
  balances: WalletBalances
  credits: WalletCredit[]
}

const GRANT_SOURCE_TO_PLATFORM: Record<WalletCreditSource, PlatformFundingKind> = {
  promo: "promo",
  plan_included: "plan_credit",
  trial: "promo",
  manual: "manual",
  credit_line: "credit_line",
}

/**
 * The funding layer. Balance is pgledger; `WalletService` composes on top of
 * `LedgerGateway` to:
 *
 *   - move money between sub-accounts (`transfer`)
 *   - open / refill / close reservations with the priority drain rule —
 *     `available.granted` first (FIFO by expiry), then `available.purchased`
 *   - issue or claw back credits (`adjust`, `expireGrant`)
 *   - settle provider-confirmed top-ups (`settleTopUp`)
 *
 * Every balance-changing method runs inside one Drizzle transaction that
 * opens with `pg_advisory_xact_lock(hashtext('customer:' || id))`. The lock
 * serializes concurrent flows for the same customer without serializing
 * the platform — an expiration job and a DO flush touching the same
 * customer queue up; different customers proceed in parallel.
 *
 * All amounts are pgledger scale 8 minor units (`$1 = 100_000_000`).
 */
export class WalletService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly ledger: LedgerGateway

  constructor(deps: WalletDeps) {
    this.db = deps.db
    this.logger = deps.logger
    this.ledger = deps.ledgerGateway
  }

  public async transfer(
    input: WalletTransferInput,
    executor?: DbExecutor
  ): Promise<Result<void, UnPriceWalletError>> {
    if (input.amount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)
    if (input.toAccountKey === keys.consumed) {
      const missing = this.missingConsumedMetadata(input.metadata)
      if (missing) {
        return Err(
          new UnPriceWalletError({
            message: "WALLET_METADATA_REQUIRED",
            context: { missing, required: ["statement_key", "kind"] },
          })
        )
      }
    }

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    const run = async (tx: DbExecutor): Promise<Result<void, UnPriceWalletError>> => {
      await this.lockCustomer(tx, input.customerId)

      const statementKey =
        typeof input.metadata.statement_key === "string" ? input.metadata.statement_key : null

      const transferResult = await this.ledger.createTransfer(
        {
          projectId: input.projectId,
          fromAccount: input.fromAccountKey,
          toAccount: input.toAccountKey,
          amount: fromLedgerMinor(input.amount, input.currency),
          source: { type: "wallet_transfer", id: input.idempotencyKey },
          statementKey,
          metadata: input.metadata,
        },
        tx
      )

      if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
      return Ok(undefined)
    }

    try {
      return executor ? await run(executor as DbExecutor) : await this.db.transaction(run)
    } catch (error) {
      return this.handleUnexpected("wallet.transfer_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
      })
    }
  }

  public async createReservation(
    input: CreateReservationInput,
    executor?: DbExecutor
  ): Promise<Result<CreateReservationOutput, UnPriceWalletError>> {
    if (input.requestedAmount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    const run = async (
      tx: DbExecutor
    ): Promise<Result<CreateReservationOutput, UnPriceWalletError>> => {
      await this.lockCustomer(tx, input.customerId)

      // Idempotency: if an *active* reservation already exists for this
      // (project, entitlement, period_start_at), hand it back so the DO can
      // rehydrate. The partial unique index on the table only covers active
      // rows (`WHERE reconciled_at IS NULL`), so closed reservations don't
      // collide and we can safely INSERT a fresh one when there's no active
      // peer — this is the post-final-flush replay path.
      const existing = await (tx as Transaction).query.entitlementReservations.findFirst({
        where: and(
          eq(entitlementReservations.projectId, input.projectId),
          eq(entitlementReservations.entitlementId, input.entitlementId),
          eq(entitlementReservations.periodStartAt, input.periodStartAt),
          isNull(entitlementReservations.reconciledAt)
        ),
      })

      if (existing) {
        return Ok({
          reservationId: existing.id,
          allocationAmount: existing.allocationAmount,
          drainLegs: this.normalizeDrainLegs(existing.drainLegs),
          reused: "active",
        })
      }

      const { drained: grantedDrained, legs: grantLegs } = await this.drainGrantedFIFO(
        tx as Transaction,
        input.customerId,
        input.projectId,
        input.requestedAmount
      )

      const stillNeeded = input.requestedAmount - grantedDrained
      const purchasedBalance = await this.readBalance(tx, keys.purchased)
      const purchasedDrained = Math.max(0, Math.min(stillNeeded, purchasedBalance))

      const allocationAmount = grantedDrained + purchasedDrained
      const reservationId = newId("entitlement_reservation")
      const drainLegs: DrainLeg[] = [
        ...grantLegs,
        ...(purchasedDrained > 0
          ? [{ source: "purchased" as const, amount: purchasedDrained }]
          : []),
      ]

      const transfers: LedgerTransferRequest[] = []

      if (grantedDrained > 0) {
        transfers.push({
          projectId: input.projectId,
          fromAccount: keys.granted,
          toAccount: keys.reserved,
          amount: fromLedgerMinor(grantedDrained, input.currency),
          source: {
            type: "wallet_reserve_granted",
            id: input.idempotencyKey,
          },
          metadata: {
            flow: "reserve",
            drain_source: "granted",
            reservation_id: reservationId,
            entitlement_id: input.entitlementId,
            grant_ids: grantLegs.map((l) => l.grantId).filter((id): id is string => !!id),
            idempotency_key: input.idempotencyKey,
          },
        })
      }

      if (purchasedDrained > 0) {
        transfers.push({
          projectId: input.projectId,
          fromAccount: keys.purchased,
          toAccount: keys.reserved,
          amount: fromLedgerMinor(purchasedDrained, input.currency),
          source: {
            type: "wallet_reserve_purchased",
            id: input.idempotencyKey,
          },
          metadata: {
            flow: "reserve",
            drain_source: "purchased",
            reservation_id: reservationId,
            entitlement_id: input.entitlementId,
            idempotency_key: input.idempotencyKey,
          },
        })
      }

      if (transfers.length > 0) {
        const transferResult = await this.ledger.createTransfers(transfers, tx)
        if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
      }

      await tx.insert(entitlementReservations).values({
        id: reservationId,
        projectId: input.projectId,
        customerId: input.customerId,
        entitlementId: input.entitlementId,
        allocationAmount,
        consumedAmount: 0,
        drainLegs: this.toStoredDrainLegs(drainLegs),
        refillThresholdBps: input.refillThresholdBps,
        refillChunkAmount: input.refillChunkAmount,
        periodStartAt: input.periodStartAt,
        periodEndAt: input.periodEndAt,
      })

      return Ok({ reservationId, allocationAmount, drainLegs })
    }

    try {
      return executor ? await run(executor) : await this.db.transaction(run)
    } catch (error) {
      return this.handleUnexpected("wallet.create_reservation_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
      })
    }
  }

  public async flushReservation(
    input: FlushReservationInput
  ): Promise<Result<FlushReservationOutput, UnPriceWalletError>> {
    if (input.flushAmount < 0 || input.refillChunkAmount < 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    try {
      // all happen in the same transaction for atomicity
      return await this.db.transaction(async (tx) => {
        // avoid concurrent reservations fighting for the last cent
        await this.lockCustomer(tx, input.customerId)

        const reservation = await tx.query.entitlementReservations.findFirst({
          where: and(
            eq(entitlementReservations.id, input.reservationId),
            eq(entitlementReservations.projectId, input.projectId)
          ),
        })

        if (!reservation) {
          return Err(new UnPriceWalletError({ message: "WALLET_RESERVATION_NOT_FOUND" }))
        }

        if (reservation.reconciledAt) {
          return Err(new UnPriceWalletError({ message: "WALLET_RESERVATION_ALREADY_RECONCILED" }))
        }

        const transfers: LedgerTransferRequest[] = []
        const idemBase = `flush:${input.reservationId}:${input.flushSeq}`

        // Leg 1 — recognize what was consumed since the last flush.
        if (input.flushAmount > 0) {
          transfers.push({
            projectId: input.projectId,
            fromAccount: keys.reserved,
            toAccount: keys.consumed,
            amount: fromLedgerMinor(input.flushAmount, input.currency),
            source: { type: "wallet_flush_consume", id: idemBase },
            metadata: {
              flow: "flush",
              ...(input.sourceId ? { source_id: input.sourceId } : {}),
              reservation_id: input.reservationId,
              flush_seq: input.flushSeq,
              final: input.final,
            },
          })
        }

        // Leg 2+ — extend runway (multi-leg drain, priority order) or final refund.
        const drainLegs: DrainLeg[] = []
        let grantedAmount = 0
        let refundedAmount = 0

        if (input.final) {
          const totalConsumedAfterFlush = reservation.consumedAmount + input.flushAmount
          const releases = this.computeFinalReleases({
            allocationAmount: reservation.allocationAmount,
            consumedAmount: totalConsumedAfterFlush,
            drainLegs: this.normalizeDrainLegs(reservation.drainLegs),
          })

          if (releases.purchasedAmount > 0) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.reserved,
              toAccount: keys.purchased,
              amount: fromLedgerMinor(releases.purchasedAmount, input.currency),
              source: {
                type: "wallet_capture_refund",
                id: `capture:${input.reservationId}:${input.flushSeq}:purchased`,
              },
              metadata: {
                flow: "refund_reserved_cash",
                source: "purchased",
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
              },
            })
            refundedAmount = releases.purchasedAmount
          }

          for (const release of releases.grantedAmounts) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.reserved,
              toAccount: platformAccountKey(
                GRANT_SOURCE_TO_PLATFORM[release.source],
                input.projectId
              ),
              amount: fromLedgerMinor(release.amount, input.currency),
              source: {
                type: "wallet_release_granted",
                id: `release:${input.reservationId}:${input.flushSeq}:${release.source}`,
              },
              metadata: {
                flow: "release_reserved_credit",
                source: release.source,
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
              },
            })
          }
        } else if (input.refillChunkAmount > 0) {
          const { drained: grantedDrained, legs: grantLegs } = await this.drainGrantedFIFO(
            tx,
            input.customerId,
            input.projectId,
            input.refillChunkAmount
          )

          const stillNeeded = input.refillChunkAmount - grantedDrained
          const purchasedBalance = await this.readBalance(tx, keys.purchased)
          const purchasedDrained = Math.max(0, Math.min(stillNeeded, purchasedBalance))

          if (grantedDrained > 0) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.granted,
              toAccount: keys.reserved,
              amount: fromLedgerMinor(grantedDrained, input.currency),
              source: { type: "wallet_refill_granted", id: idemBase },
              metadata: {
                flow: "refill",
                drain_source: "granted",
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
                idempotency_key: idemBase,
                grant_ids: grantLegs.map((l) => l.grantId).filter((id): id is string => !!id),
              },
            })
          }

          if (purchasedDrained > 0) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.purchased,
              toAccount: keys.reserved,
              amount: fromLedgerMinor(purchasedDrained, input.currency),
              source: { type: "wallet_refill_purchased", id: idemBase },
              metadata: {
                flow: "refill",
                drain_source: "purchased",
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
                idempotency_key: idemBase,
              },
            })
          }

          grantedAmount = grantedDrained + purchasedDrained
          drainLegs.push(...grantLegs)
          if (purchasedDrained > 0) {
            drainLegs.push({ source: "purchased", amount: purchasedDrained })
          }
        }

        if (transfers.length > 0) {
          const transferResult = await this.ledger.createTransfers(transfers, tx)
          if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
        }

        const newConsumed = reservation.consumedAmount + input.flushAmount
        const newAllocation = reservation.allocationAmount + grantedAmount

        // update the reservation so we have a way to say the current status of the system
        // withput waiting for sources to report
        await tx
          .update(entitlementReservations)
          .set({
            consumedAmount: newConsumed,
            allocationAmount: newAllocation,
            ...(!input.final
              ? {
                  drainLegs: this.toStoredDrainLegs([
                    ...this.normalizeDrainLegs(reservation.drainLegs),
                    ...drainLegs,
                  ]),
                }
              : {}),
            ...(input.final ? { reconciledAt: new Date() } : {}),
          })
          .where(
            and(
              eq(entitlementReservations.id, input.reservationId),
              eq(entitlementReservations.projectId, input.projectId)
            )
          )

        return Ok({
          grantedAmount,
          flushedAmount: input.flushAmount,
          refundedAmount,
          drainLegs,
        })
      })
    } catch (error) {
      return this.handleUnexpected("wallet.flush_reservation_failed", error, {
        reservationId: input.reservationId,
        projectId: input.projectId,
      })
    }
  }

  public async adjust(
    input: AdjustInput,
    executor?: DbExecutor
  ): Promise<Result<AdjustOutput, UnPriceWalletError>> {
    if (input.signedAmount === 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)
    const isPositive = input.signedAmount > 0
    const absAmount = Math.abs(input.signedAmount)

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    const run = async (tx: DbExecutor): Promise<Result<AdjustOutput, UnPriceWalletError>> => {
      await this.lockCustomer(tx, input.customerId)

      if (isPositive) {
        return await this.adjustPositive(tx as Transaction, input, absAmount, keys)
      }
      return await this.adjustNegative(tx as Transaction, input, absAmount, keys)
    }

    try {
      return executor ? await run(executor) : await this.db.transaction(run)
    } catch (error) {
      return this.handleUnexpected("wallet.adjust_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
      })
    }
  }

  public async settleTopUp(
    input: SettleTopUpInput
  ): Promise<Result<SettleTopUpOutput, UnPriceWalletError>> {
    if (input.paidAmount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, input.customerId)

        const topup = await tx.query.walletTopups.findFirst({
          where: and(
            eq(walletTopups.projectId, input.projectId),
            eq(walletTopups.providerSessionId, input.providerSessionId)
          ),
        })

        if (!topup) {
          return Err(new UnPriceWalletError({ message: "WALLET_TOPUP_NOT_FOUND" }))
        }

        // If already completed with a ledger transfer, treat as idempotent success.
        if (topup.status === "completed" && topup.ledgerTransferId) {
          return Ok({
            topupId: topup.id,
            ledgerTransferId: topup.ledgerTransferId,
          })
        }

        if (topup.status !== "pending") {
          return Err(
            new UnPriceWalletError({
              message: "WALLET_TOPUP_ALREADY_SETTLED",
              context: { status: topup.status },
            })
          )
        }

        const fromAccount = platformAccountKey("topup", input.projectId)

        const transferResult = await this.ledger.createTransfer(
          {
            projectId: input.projectId,
            fromAccount,
            toAccount: keys.purchased,
            amount: fromLedgerMinor(input.paidAmount, input.currency),
            source: { type: "wallet_topup", id: input.idempotencyKey },
            metadata: {
              flow: "topup",
              source: "purchased",
              topup_id: topup.id,
              provider: topup.provider,
              provider_session_id: topup.providerSessionId,
              external_ref: input.idempotencyKey,
            },
          },
          tx
        )

        if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))

        await tx
          .update(walletTopups)
          .set({
            status: "completed",
            completedAt: new Date(),
            settledAmount: input.paidAmount,
            ledgerTransferId: transferResult.val.id,
          })
          .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.projectId, topup.projectId)))

        return Ok({ topupId: topup.id, ledgerTransferId: transferResult.val.id })
      })
    } catch (error) {
      return this.handleUnexpected("wallet.settle_topup_failed", error, {
        providerSessionId: input.providerSessionId,
        projectId: input.projectId,
      })
    }
  }

  /**
   * Zeroes out the receivable a customer accrued when an invoice was drafted
   * (`receivable → consumed` debited receivable into the negative). On
   * confirmed payment, post `platform.topup → customer.receivable` to bring
   * the receivable balance back toward zero. Idempotency is keyed on the
   * caller-supplied key (typically `invoice_receivable:{invoiceId}`) via the
   * ledger's `source.type + source.id` uniqueness — duplicate webhook
   * deliveries reuse the existing transfer instead of double-settling.
   */
  public async settleReceivable(
    input: SettleReceivableInput
  ): Promise<Result<SettleReceivableOutput, UnPriceWalletError>> {
    if (input.paidAmount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)

    const seeded = await this.ensureCustomerSeeded(input.customerId, input.currency)
    if (seeded.err) return seeded

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, input.customerId)

        const fromAccount = platformAccountKey("topup", input.projectId)

        const transferResult = await this.ledger.createTransfer(
          {
            projectId: input.projectId,
            fromAccount,
            toAccount: keys.receivable,
            amount: fromLedgerMinor(input.paidAmount, input.currency),
            source: { type: "wallet_settle_receivable", id: input.idempotencyKey },
            metadata: {
              flow: "settle_receivable",
              source: "receivable",
              external_ref: input.idempotencyKey,
              ...(input.metadata ?? {}),
            },
          },
          tx
        )

        if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))

        return Ok({ ledgerTransferId: transferResult.val.id })
      })
    } catch (error) {
      return this.handleUnexpected("wallet.settle_receivable_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
      })
    }
  }

  /**
   * Clawback a grant's remaining balance. Called by the expiration job
   * inside its own transaction (after it has acquired the customer advisory
   * lock and re-read the grant row). The caller owns the grant-row
   * bookkeeping — this method only moves money in the ledger.
   */
  public async expireGrant(
    tx: Transaction,
    input: ExpireGrantInput
  ): Promise<Result<void, UnPriceWalletError>> {
    if (input.amount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)
    const toAccount = platformAccountKey(GRANT_SOURCE_TO_PLATFORM[input.source], input.projectId)

    const transferResult = await this.ledger.createTransfer(
      {
        projectId: input.projectId,
        fromAccount: keys.granted,
        toAccount,
        amount: fromLedgerMinor(input.amount, input.currency),
        source: { type: "wallet_expire_grant", id: input.idempotencyKey },
        metadata: {
          flow: "expire",
          grant_id: input.grantId,
          source: input.source,
          expired_amount: input.amount,
          idempotency_key: input.idempotencyKey,
        },
      },
      tx
    )

    if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
    return Ok(undefined)
  }

  /**
   * Read-only snapshot of the customer's wallet: the four sub-account
   * balances and the list of active credits (not expired, not voided,
   * `remaining_amount > 0`). Missing ledger accounts report zero — a
   * customer who has never transacted is not an error, just an empty
   * wallet. No advisory lock: balances are eventually consistent with
   * in-flight writes, which is what a read endpoint wants.
   */
  public async getWalletState(
    input: GetWalletStateInput
  ): Promise<Result<WalletStateOutput, UnPriceWalletError>> {
    const keys = customerAccountKeys(input.customerId)

    try {
      const [purchased, granted, reserved, consumed, credits] = await Promise.all([
        this.readBalance(this.db, keys.purchased),
        this.readBalance(this.db, keys.granted),
        this.readBalance(this.db, keys.reserved),
        this.readBalance(this.db, keys.consumed),
        this.db.query.walletCredits.findMany({
          where: and(
            eq(walletCredits.customerId, input.customerId),
            eq(walletCredits.projectId, input.projectId),
            isNull(walletCredits.expiredAt),
            isNull(walletCredits.voidedAt),
            gt(walletCredits.remainingAmount, 0)
          ),
          orderBy: [
            sql`COALESCE(${walletCredits.expiresAt}, 'infinity'::timestamptz) ASC`,
            asc(walletCredits.createdAt),
          ],
        }),
      ])

      return Ok({
        balances: { purchased, granted, reserved, consumed },
        credits,
      })
    } catch (error) {
      return this.handleUnexpected("wallet.get_state_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async adjustPositive(
    tx: Transaction,
    input: AdjustInput,
    amount: number,
    keys: ReturnType<typeof customerAccountKeys>
  ): Promise<Result<AdjustOutput, UnPriceWalletError>> {
    const commonMetadata = {
      flow: "adjust",
      source: input.source,
      actor_id: input.actorId,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
      ...(input.metadata ?? {}),
    }

    if (input.source === "purchased") {
      const fromAccount = platformAccountKey("manual", input.projectId)
      const transferResult = await this.ledger.createTransfer(
        {
          projectId: input.projectId,
          fromAccount,
          toAccount: keys.purchased,
          amount: fromLedgerMinor(amount, input.currency),
          source: { type: "wallet_adjust", id: input.idempotencyKey },
          metadata: commonMetadata,
        },
        tx
      )
      if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
      return Ok({ clampedAmount: amount, unclampedRemainder: 0 })
    }

    const platformKind = GRANT_SOURCE_TO_PLATFORM[input.source as WalletCreditSource]
    const fromAccount = platformAccountKey(platformKind, input.projectId)
    const grantId = newId("wallet_credit")

    const transferResult = await this.ledger.createTransfer(
      {
        projectId: input.projectId,
        fromAccount,
        toAccount: keys.granted,
        amount: fromLedgerMinor(amount, input.currency),
        source: { type: "wallet_adjust", id: input.idempotencyKey },
        metadata: {
          ...commonMetadata,
          grant_id: grantId,
          expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
        },
      },
      tx
    )
    if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))

    // Idempotent insert: the unique index `wallet_credits_ledger_transfer_idx`
    // on (customer_id, ledger_transfer_id) means a replay (same idempotency
    // key → same ledger transfer) must reuse the prior grant row instead of
    // inserting a fresh one. ON CONFLICT DO NOTHING + fallback lookup keeps
    // both the first call and any retry returning the same grantId.
    const inserted = await tx
      .insert(walletCredits)
      .values({
        id: grantId,
        projectId: input.projectId,
        customerId: input.customerId,
        source: input.source as WalletCreditSource,
        issuedAmount: amount,
        remainingAmount: amount,
        expiresAt: input.expiresAt ?? null,
        ledgerTransferId: transferResult.val.id,
        metadata: this.sanitizeGrantMetadata({
          actor_id: input.actorId,
          reason: input.reason,
          ...(input.metadata ?? {}),
        }),
      })
      .onConflictDoNothing({
        target: [walletCredits.customerId, walletCredits.ledgerTransferId],
      })
      .returning({ id: walletCredits.id })

    if (inserted.length > 0) {
      return Ok({ clampedAmount: amount, unclampedRemainder: 0, grantId: inserted[0]!.id })
    }

    const existing = await tx.query.walletCredits.findFirst({
      columns: { id: true },
      where: and(
        eq(walletCredits.customerId, input.customerId),
        eq(walletCredits.projectId, input.projectId),
        eq(walletCredits.ledgerTransferId, transferResult.val.id)
      ),
    })

    if (!existing) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_LEDGER_FAILED",
          context: {
            event: "wallet.adjust_grant_lookup_missing",
            ledgerTransferId: transferResult.val.id,
          },
        })
      )
    }

    return Ok({ clampedAmount: amount, unclampedRemainder: 0, grantId: existing.id })
  }

  private async adjustNegative(
    tx: Transaction,
    input: AdjustInput,
    amount: number,
    keys: ReturnType<typeof customerAccountKeys>
  ): Promise<Result<AdjustOutput, UnPriceWalletError>> {
    const commonMetadata = {
      flow: "adjust",
      source: input.source,
      actor_id: input.actorId,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
      sign: "negative",
      ...(input.metadata ?? {}),
    }

    if (input.source === "purchased") {
      const balance = await this.readBalance(tx, keys.purchased)
      const clamped = Math.min(amount, balance)
      const remainder = amount - clamped

      if (clamped > 0) {
        const toAccount = platformAccountKey("manual", input.projectId)
        const transferResult = await this.ledger.createTransfer(
          {
            projectId: input.projectId,
            fromAccount: keys.purchased,
            toAccount,
            amount: fromLedgerMinor(clamped, input.currency),
            source: { type: "wallet_adjust", id: input.idempotencyKey },
            metadata: commonMetadata,
          },
          tx
        )
        if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
      }
      return Ok({ clampedAmount: clamped, unclampedRemainder: remainder })
    }

    // Negative adjust from a granted source — drain remaining grants FIFO
    // and clawback to the matching platform funding account.
    const { drained, legs } = await this.drainGrantedFIFO(
      tx,
      input.customerId,
      input.projectId,
      amount
    )
    const remainder = amount - drained

    if (drained > 0) {
      const toAccount = platformAccountKey(
        GRANT_SOURCE_TO_PLATFORM[input.source as WalletCreditSource],
        input.projectId
      )
      const transferResult = await this.ledger.createTransfer(
        {
          projectId: input.projectId,
          fromAccount: keys.granted,
          toAccount,
          amount: fromLedgerMinor(drained, input.currency),
          source: { type: "wallet_adjust", id: input.idempotencyKey },
          metadata: {
            ...commonMetadata,
            grant_ids: legs.map((l) => l.grantId).filter((id): id is string => !!id),
          },
        },
        tx
      )
      if (transferResult.err) return Err(this.wrapLedgerError(transferResult.err))
    }

    return Ok({ clampedAmount: drained, unclampedRemainder: remainder })
  }

  /**
   * Drain from `available.granted` FIFO by grant expiry. Updates
   * `wallet_credits.remaining_amount` in the same tx as the ledger transfer,
   * preserving the invariant:
   *
   *   SUM(remaining_amount WHERE active) == available.granted balance
   *
   * Stops early when the requested amount is satisfied or grants run out.
   * Returns the actual drained amount (may be less than requested) and a
   * per-grant breakdown for attribution metadata.
   */
  private async drainGrantedFIFO(
    tx: Transaction,
    customerId: string,
    projectId: string,
    requestedAmount: number
  ): Promise<{ drained: number; legs: DrainLeg[] }> {
    const now = new Date()
    const activeGrants = await tx.query.walletCredits.findMany({
      where: and(
        eq(walletCredits.customerId, customerId),
        eq(walletCredits.projectId, projectId),
        isNull(walletCredits.expiredAt),
        isNull(walletCredits.voidedAt),
        gt(walletCredits.remainingAmount, 0),
        // Belt-and-suspenders: skip grants whose expiry has passed even if
        // the nightly cron hasn't marked them yet
        or(isNull(walletCredits.expiresAt), gt(walletCredits.expiresAt, now))
      ),
      orderBy: [
        // soonest-expiring first; never-expiring last
        sql`COALESCE(${walletCredits.expiresAt}, 'infinity'::timestamptz) ASC`,
        asc(walletCredits.createdAt),
      ],
    })

    let remaining = requestedAmount
    const legs: DrainLeg[] = []

    for (const grant of activeGrants) {
      if (remaining <= 0) break
      const drain = Math.min(remaining, grant.remainingAmount)

      await tx
        .update(walletCredits)
        .set({ remainingAmount: grant.remainingAmount - drain })
        .where(and(eq(walletCredits.id, grant.id), eq(walletCredits.projectId, grant.projectId)))

      legs.push({
        source: "granted",
        amount: drain,
        grantId: grant.id,
        grantSource: grant.source,
      })

      remaining -= drain
    }

    return { drained: requestedAmount - remaining, legs }
  }

  private normalizeDrainLegs(value: unknown): DrainLeg[] {
    if (!Array.isArray(value)) return []

    return value.flatMap((leg): DrainLeg[] => {
      if (!leg || typeof leg !== "object") return []
      const record = leg as Record<string, unknown>
      const amount = typeof record.amount === "number" ? record.amount : 0
      if (amount <= 0) return []

      if (record.source === "purchased") {
        return [{ source: "purchased", amount }]
      }

      if (record.source === "granted") {
        const grantSource = record.grantSource
        if (!this.isWalletCreditSource(grantSource)) return []

        return [
          {
            source: "granted",
            amount,
            grantId: typeof record.grantId === "string" ? record.grantId : undefined,
            grantSource,
          },
        ]
      }

      return []
    })
  }

  private toStoredDrainLegs(legs: DrainLeg[]): EntitlementReservationDrainLeg[] {
    return legs.map((leg) => ({
      source: leg.source,
      amount: leg.amount,
      ...(leg.grantId ? { grantId: leg.grantId } : {}),
      ...(leg.grantSource ? { grantSource: leg.grantSource } : {}),
    }))
  }

  private computeFinalReleases(input: {
    allocationAmount: number
    consumedAmount: number
    drainLegs: DrainLeg[]
  }): {
    purchasedAmount: number
    grantedAmounts: Array<{ source: WalletCreditSource; amount: number }>
  } {
    const attributedTotal = input.drainLegs.reduce((sum, leg) => sum + leg.amount, 0)
    if (attributedTotal !== input.allocationAmount) {
      throw new UnPriceWalletError({
        message: "WALLET_METADATA_REQUIRED",
        context: {
          missing: "reservation.drain_legs",
          allocationAmount: input.allocationAmount,
          attributedTotal,
        },
      })
    }

    let remainingConsumption = input.consumedAmount
    let purchasedAmount = 0
    const grantedBySource = new Map<WalletCreditSource, number>()

    for (const leg of input.drainLegs) {
      const consumedFromLeg = Math.min(leg.amount, Math.max(0, remainingConsumption))
      remainingConsumption -= consumedFromLeg
      const unused = leg.amount - consumedFromLeg
      if (unused <= 0) continue

      if (leg.source === "purchased") {
        purchasedAmount += unused
        continue
      }

      if (!leg.grantSource) {
        throw new UnPriceWalletError({
          message: "WALLET_METADATA_REQUIRED",
          context: { missing: "drain_legs.grantSource" },
        })
      }

      grantedBySource.set(leg.grantSource, (grantedBySource.get(leg.grantSource) ?? 0) + unused)
    }

    return {
      purchasedAmount,
      grantedAmounts: [...grantedBySource.entries()].map(([source, amount]) => ({
        source,
        amount,
      })),
    }
  }

  private isWalletCreditSource(value: unknown): value is WalletCreditSource {
    return (
      value === "promo" ||
      value === "plan_included" ||
      value === "trial" ||
      value === "manual" ||
      value === "credit_line"
    )
  }

  private async readBalance(tx: DbExecutor, accountName: string): Promise<number> {
    const result = await this.ledger.getAccountBalanceIn(accountName, tx)
    if (result.err) return 0
    return toLedgerMinor(result.val)
  }

  private async lockCustomer(tx: DbExecutor, customerId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${customerId}`}))`)
  }

  /**
   * Idempotently seeds the four `customer.{id}.*` ledger accounts before any
   * balance-changing operation. Cached in the gateway, so the round-trip
   * happens once per `(customer, currency)` per worker. Runs outside the
   * caller's transaction because seeding opens its own.
   */
  private async ensureCustomerSeeded(
    customerId: string,
    currency: Currency
  ): Promise<Result<void, UnPriceWalletError>> {
    const result = await this.ledger.ensureCustomerAccounts(customerId, currency)
    if (result.err) return Err(this.wrapLedgerError(result.err))
    return Ok(undefined)
  }

  private missingConsumedMetadata(metadata: Record<string, unknown>): string[] | null {
    const missing: string[] = []
    if (typeof metadata.statement_key !== "string" || metadata.statement_key.length === 0) {
      missing.push("statement_key")
    }
    if (typeof metadata.kind !== "string" || metadata.kind.length === 0) {
      missing.push("kind")
    }
    return missing.length === 0 ? null : missing
  }

  private wrapLedgerError(error: UnPriceLedgerError): UnPriceWalletError {
    return new UnPriceWalletError({
      message: "WALLET_LEDGER_FAILED",
      context: {
        ledgerCode: error.message,
        ...(error.context ?? {}),
      },
    })
  }

  private sanitizeGrantMetadata(
    metadata: Record<string, unknown>
  ): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        out[key] = value
      } else {
        out[key] = JSON.stringify(value)
      }
    }
    return out
  }

  private handleUnexpected(
    event: string,
    error: unknown,
    context: Record<string, unknown>
  ): Result<never, UnPriceWalletError> {
    if (error instanceof UnPriceWalletError) {
      return Err(error)
    }
    if (error instanceof UnPriceLedgerError) {
      return Err(this.wrapLedgerError(error))
    }
    this.logger.error(event, { error: toErrorContext(error), ...context })
    return Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED", context: { event } }))
  }
}

/**
 * Source identity conventions — surfaced as constants so test suites and
 * consumers can correlate ledger idempotency rows with the wallet flow that
 * wrote them without magic strings.
 */
export const WALLET_SOURCE_TYPES = {
  transfer: "wallet_transfer",
  reserveGranted: "wallet_reserve_granted",
  reservePurchased: "wallet_reserve_purchased",
  flushConsume: "wallet_flush_consume",
  refillGranted: "wallet_refill_granted",
  refillPurchased: "wallet_refill_purchased",
  captureRefund: "wallet_capture_refund",
  releaseGranted: "wallet_release_granted",
  adjust: "wallet_adjust",
  topup: "wallet_topup",
  expireGrant: "wallet_expire_grant",
} as const satisfies Record<string, LedgerSource["type"]>
