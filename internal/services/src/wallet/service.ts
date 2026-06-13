import { type Database, and, asc, eq, gt, isNull, or, sql } from "@unprice/db"
import {
  entitlementReservationFundingLegs,
  entitlementReservations,
  walletCommandIdempotency,
  walletCredits,
  walletTopups,
} from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type {
  Currency,
  EntitlementReservationFundingLeg,
  WalletCredit,
  WalletCreditSource,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"

import { mapWalletFundingToSettlement } from "../billing/invoice-settlement"
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

type FundingAllocation = {
  source: "granted" | "purchased"
  amount: number
  walletCreditId?: string
  grantSource?: WalletCreditSource
}

type CapturedReservationFundingAllocation = {
  amount: number
  fundingLegId: string
  grantSource: WalletCreditSource | null
  source: "granted" | "purchased"
  walletCreditId: string | null
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
  metadata?: Record<string, unknown>
  idempotencyKey: string
  /** Time used to decide which wallet credits are drainable. Defaults to now. */
  effectiveAt?: Date
}

export interface CreateReservationOutput {
  reservationId: string
  allocationAmount: number
  // Set to "active" when an existing active reservation row was found for
  // this (project, entitlement, period_start_at) tuple instead of a fresh
  // insert. The DO uses this to preserve flush bookkeeping (consumed,
  // flushed, flushSeq) on rehydration. Closed reservations are ignored
  // — the partial unique index lets us INSERT a fresh row alongside them.
  reused?: "active"
}

export interface CaptureReservationUsageInput {
  projectId: string
  customerId: string
  currency: Currency
  reservationId: string
  flushSeq: number
  amount: number
  statementKey: string
  billingPeriodId?: string
  kind?: string
  metadata?: Record<string, unknown>
  sourceId?: string
}

export interface CaptureReservationUsageOutput {
  capturedAmount: number
}

export interface ExtendReservationInput {
  projectId: string
  customerId: string
  currency: Currency
  reservationId: string
  flushSeq: number
  requestedAmount: number
  statementKey: string
  metadata?: Record<string, unknown>
  sourceId?: string
  /** Time used to decide which wallet credits are drainable. Defaults to now. */
  effectiveAt?: Date
}

export interface ExtendReservationOutput {
  grantedAmount: number
}

export type ReservationCloseReason =
  | "inactivity"
  | "limit_reached"
  | "wallet_empty"
  | "deletion_requested"
  | "period_close"
  | "manual"

export interface ReleaseReservationInput {
  projectId: string
  customerId: string
  currency: Currency
  reservationId: string
  closeReason: ReservationCloseReason
  idempotencyKey: string
  metadata?: Record<string, unknown>
  sourceId?: string
}

export interface ReleaseReservationOutput {
  releasedAmount: number
  restoredGrantedAmount: number
  refundedPurchasedAmount: number
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

export interface GetWalletCreditBalanceInput {
  projectId: string
  customerId: string
  walletId: string
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

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency,
      executor
    )
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
    const reservationMetadata = this.normalizeJsonMetadata(input.metadata)

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency,
      executor
    )
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
          reused: "active",
        })
      }

      const { drained: grantedDrained, allocations: grantAllocations } =
        await this.drainGrantedFIFO(
          tx as Transaction,
          input.customerId,
          input.projectId,
          input.requestedAmount,
          input.effectiveAt ?? new Date()
        )

      const stillNeeded = input.requestedAmount - grantedDrained
      const purchasedBalance = await this.readBalance(tx, keys.purchased)
      const purchasedDrained = Math.max(0, Math.min(stillNeeded, purchasedBalance))

      const allocationAmount = grantedDrained + purchasedDrained
      const reservationId = newId("entitlement_reservation")
      const reserveLedgerSourceId = `${input.idempotencyKey}:${reservationId}`
      const fundingAllocations: FundingAllocation[] = [
        ...grantAllocations,
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
            id: reserveLedgerSourceId,
          },
          metadata: {
            ...(reservationMetadata ?? {}),
            flow: "reserve",
            drain_source: "granted",
            reservation_id: reservationId,
            entitlement_id: input.entitlementId,
            grant_ids: grantAllocations
              .map((allocation) => allocation.walletCreditId)
              .filter((id): id is string => !!id),
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
            id: reserveLedgerSourceId,
          },
          metadata: {
            ...(reservationMetadata ?? {}),
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
        if (transferResult.err) throw this.wrapLedgerError(transferResult.err)
      }

      await tx.insert(entitlementReservations).values({
        id: reservationId,
        projectId: input.projectId,
        customerId: input.customerId,
        entitlementId: input.entitlementId,
        allocationAmount,
        consumedAmount: 0,
        ...(reservationMetadata ? { metadata: reservationMetadata } : {}),
        refillThresholdBps: input.refillThresholdBps,
        refillChunkAmount: input.refillChunkAmount,
        periodStartAt: input.periodStartAt,
        periodEndAt: input.periodEndAt,
      })

      if (fundingAllocations.length > 0) {
        await tx.insert(entitlementReservationFundingLegs).values(
          this.toFundingLegRows({
            projectId: input.projectId,
            reservationId,
            allocations: fundingAllocations,
            startSequence: 1,
          })
        )
      }

      return Ok({ reservationId, allocationAmount })
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

  public async captureReservationUsage(
    input: CaptureReservationUsageInput
  ): Promise<Result<CaptureReservationUsageOutput, UnPriceWalletError>> {
    if (input.amount < 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)
    const captureMetadata = this.normalizeJsonMetadata(input.metadata)
    const idempotencyKey = `capture:${input.reservationId}:${input.flushSeq}`
    const command = "captureReservationUsage"
    const payloadHash = this.commandPayloadHash({
      amount: input.amount,
      command,
      currency: input.currency,
      customerId: input.customerId,
      billingPeriodId: input.billingPeriodId ?? null,
      flushSeq: input.flushSeq,
      kind: input.kind ?? null,
      metadata: captureMetadata,
      projectId: input.projectId,
      reservationId: input.reservationId,
      sourceId: input.sourceId ?? null,
      statementKey: input.statementKey,
    })

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency
    )
    if (seeded.err) return seeded

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, input.customerId)

        const replay = await this.readWalletCommandResult<CaptureReservationUsageOutput>(tx, {
          command,
          idempotencyKey,
          payloadHash,
          projectId: input.projectId,
        })
        if (replay.err) return replay
        if (replay.val) return Ok(replay.val)

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

        if (input.amount > 0) {
          const captured = await this.captureFundingLegs(tx, {
            amount: input.amount,
            projectId: input.projectId,
            reservationId: input.reservationId,
          })
          if (captured.err) return captured

          const groupedAllocations = new Map<
            string,
            {
              allocation: CapturedReservationFundingAllocation
              amount: number
              settlement: ReturnType<typeof mapWalletFundingToSettlement>
            }
          >()

          for (const allocation of captured.val) {
            const settlement =
              allocation.source === "purchased"
                ? mapWalletFundingToSettlement({ source: "purchased", grantSource: null })
                : mapWalletFundingToSettlement({
                    source: "granted",
                    grantSource: allocation.grantSource,
                  })
            const groupKey = `${settlement.settlementSource}:${allocation.walletCreditId ?? "wallet"}`
            const existing = groupedAllocations.get(groupKey)
            if (existing) {
              existing.amount += allocation.amount
              continue
            }
            groupedAllocations.set(groupKey, {
              allocation,
              amount: allocation.amount,
              settlement,
            })
          }

          for (const [groupKey, group] of groupedAllocations) {
            const { allocation, settlement } = group
            const sourceId = `capture:${input.reservationId}:${input.flushSeq}:${groupKey}`
            const invoiceMetadata =
              settlement.invoiceVisibleCapture && input.billingPeriodId
                ? {
                    billing_period_id: input.billingPeriodId,
                    invoice_visible: true,
                    kind: input.kind ?? "usage",
                    statement_key: input.statementKey,
                    ...(input.sourceId ? { source_id: input.sourceId } : {}),
                  }
                : { invoice_visible: false }

            const transferResult = await this.ledger.createTransfer(
              {
                projectId: input.projectId,
                fromAccount: keys.reserved,
                toAccount: keys.consumed,
                amount: fromLedgerMinor(group.amount, input.currency),
                source: { type: "wallet_capture_usage", id: sourceId },
                statementKey: input.statementKey,
                metadata: {
                  ...(captureMetadata ?? {}),
                  ...invoiceMetadata,
                  collectable: settlement.collectable,
                  flow: "capture",
                  flush_seq: input.flushSeq,
                  idempotency_key: sourceId,
                  reservation_id: input.reservationId,
                  settlement_source: settlement.settlementSource,
                  settlement_status: settlement.settlementStatus,
                  wallet_credit_id: allocation.walletCreditId,
                  wallet_credit_source: allocation.grantSource,
                },
              },
              tx
            )
            if (transferResult.err) throw this.wrapLedgerError(transferResult.err)
          }
        }

        const output: CaptureReservationUsageOutput = { capturedAmount: input.amount }

        await tx
          .update(entitlementReservations)
          .set({ consumedAmount: reservation.consumedAmount + input.amount })
          .where(
            and(
              eq(entitlementReservations.id, input.reservationId),
              eq(entitlementReservations.projectId, input.projectId)
            )
          )

        await this.recordWalletCommandResult(tx, {
          command,
          idempotencyKey,
          payloadHash,
          projectId: input.projectId,
          result: output,
        })

        return Ok(output)
      })
    } catch (error) {
      return this.handleUnexpected("wallet.capture_reservation_usage_failed", error, {
        reservationId: input.reservationId,
        projectId: input.projectId,
      })
    }
  }

  public async extendReservation(
    input: ExtendReservationInput
  ): Promise<Result<ExtendReservationOutput, UnPriceWalletError>> {
    if (input.requestedAmount < 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)
    const extendMetadata = this.normalizeJsonMetadata(input.metadata)
    const idempotencyKey = `extend:${input.reservationId}:${input.flushSeq}`
    const effectiveAt = input.effectiveAt ?? new Date()
    const command = "extendReservation"
    const payloadHash = this.commandPayloadHash({
      command,
      currency: input.currency,
      customerId: input.customerId,
      effectiveAt: effectiveAt.toISOString(),
      flushSeq: input.flushSeq,
      projectId: input.projectId,
      requestedAmount: input.requestedAmount,
      reservationId: input.reservationId,
      statementKey: input.statementKey,
    })

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency
    )
    if (seeded.err) return seeded

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, input.customerId)

        const replay = await this.readWalletCommandResult<ExtendReservationOutput>(tx, {
          command,
          idempotencyKey,
          payloadHash,
          projectId: input.projectId,
        })
        if (replay.err) return replay
        if (replay.val) return Ok(replay.val)

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
        const fundingAllocations: FundingAllocation[] = []
        let grantedAmount = 0

        if (input.requestedAmount > 0) {
          const { drained: grantedDrained, allocations: grantAllocations } =
            await this.drainGrantedFIFO(
              tx,
              input.customerId,
              input.projectId,
              input.requestedAmount,
              effectiveAt
            )

          const stillNeeded = input.requestedAmount - grantedDrained
          const purchasedBalance = await this.readBalance(tx, keys.purchased)
          const purchasedDrained = Math.max(0, Math.min(stillNeeded, purchasedBalance))

          if (grantedDrained > 0) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.granted,
              toAccount: keys.reserved,
              amount: fromLedgerMinor(grantedDrained, input.currency),
              source: { type: "wallet_extend_granted", id: idempotencyKey },
              metadata: {
                ...(extendMetadata ?? {}),
                flow: "extend",
                drain_source: "granted",
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
                idempotency_key: idempotencyKey,
                grant_ids: grantAllocations
                  .map((allocation) => allocation.walletCreditId)
                  .filter((id): id is string => !!id),
              },
            })
          }

          if (purchasedDrained > 0) {
            transfers.push({
              projectId: input.projectId,
              fromAccount: keys.purchased,
              toAccount: keys.reserved,
              amount: fromLedgerMinor(purchasedDrained, input.currency),
              source: { type: "wallet_extend_purchased", id: idempotencyKey },
              metadata: {
                ...(extendMetadata ?? {}),
                flow: "extend",
                drain_source: "purchased",
                reservation_id: input.reservationId,
                flush_seq: input.flushSeq,
                idempotency_key: idempotencyKey,
              },
            })
          }

          grantedAmount = grantedDrained + purchasedDrained
          fundingAllocations.push(...grantAllocations)
          if (purchasedDrained > 0) {
            fundingAllocations.push({ source: "purchased", amount: purchasedDrained })
          }
        }

        if (transfers.length > 0) {
          const transferResult = await this.ledger.createTransfers(transfers, tx)
          if (transferResult.err) throw this.wrapLedgerError(transferResult.err)
        }

        const newAllocation = reservation.allocationAmount + grantedAmount

        if (fundingAllocations.length > 0) {
          const nextSequence = await this.nextFundingLegSequence(tx, {
            projectId: input.projectId,
            reservationId: input.reservationId,
          })
          await tx.insert(entitlementReservationFundingLegs).values(
            this.toFundingLegRows({
              projectId: input.projectId,
              reservationId: input.reservationId,
              allocations: fundingAllocations,
              startSequence: nextSequence,
            })
          )
        }

        await tx
          .update(entitlementReservations)
          .set({
            allocationAmount: newAllocation,
          })
          .where(
            and(
              eq(entitlementReservations.id, input.reservationId),
              eq(entitlementReservations.projectId, input.projectId)
            )
          )

        const output: ExtendReservationOutput = {
          grantedAmount,
        }

        await this.recordWalletCommandResult(tx, {
          command,
          idempotencyKey,
          payloadHash,
          projectId: input.projectId,
          result: output,
        })

        return Ok(output)
      })
    } catch (error) {
      return this.handleUnexpected("wallet.extend_reservation_failed", error, {
        reservationId: input.reservationId,
        projectId: input.projectId,
      })
    }
  }

  public async releaseReservation(
    input: ReleaseReservationInput
  ): Promise<Result<ReleaseReservationOutput, UnPriceWalletError>> {
    const keys = customerAccountKeys(input.customerId)
    const releaseMetadata = this.normalizeJsonMetadata(input.metadata)
    const command = "releaseReservation"
    const payloadHash = this.commandPayloadHash({
      closeReason: input.closeReason,
      command,
      currency: input.currency,
      customerId: input.customerId,
      projectId: input.projectId,
      reservationId: input.reservationId,
    })

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency
    )
    if (seeded.err) return seeded

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockCustomer(tx, input.customerId)

        const replay = await this.readWalletCommandResult<ReleaseReservationOutput>(tx, {
          command,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          projectId: input.projectId,
        })
        if (replay.err) return replay
        if (replay.val) return Ok(replay.val)

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

        const fundingLegs = await this.readFundingLegs(tx, {
          projectId: input.projectId,
          reservationId: input.reservationId,
        })
        const attribution = this.computeReservationRelease(fundingLegs)
        if (attribution.err) return attribution

        const grantsToRestore = new Map<
          string,
          { currentRemaining: number; releaseAmount: number }
        >()
        for (const [walletCreditId, release] of attribution.val.grantedByCredit) {
          const grant = await tx.query.walletCredits.findFirst({
            where: and(
              eq(walletCredits.id, walletCreditId),
              eq(walletCredits.projectId, input.projectId)
            ),
          })
          if (!grant) {
            return Err(
              new UnPriceWalletError({
                message: "WALLET_GRANT_NOT_FOUND",
                context: { grantId: walletCreditId, reservationId: input.reservationId },
              })
            )
          }
          grantsToRestore.set(walletCreditId, {
            currentRemaining: grant.remainingAmount,
            releaseAmount: release.amount,
          })
        }

        const transfers: LedgerTransferRequest[] = []

        if (attribution.val.purchasedAmount > 0) {
          transfers.push({
            projectId: input.projectId,
            fromAccount: keys.reserved,
            toAccount: keys.purchased,
            amount: fromLedgerMinor(attribution.val.purchasedAmount, input.currency),
            source: {
              type: "wallet_release_reservation",
              id: `${input.idempotencyKey}:purchased`,
            },
            metadata: {
              ...(releaseMetadata ?? {}),
              flow: "release_reservation",
              source: "purchased",
              close_reason: input.closeReason,
              ...(input.sourceId ? { source_id: input.sourceId } : {}),
              reservation_id: input.reservationId,
              idempotency_key: input.idempotencyKey,
            },
          })
        }

        for (const [walletCreditId, release] of attribution.val.grantedByCredit) {
          transfers.push({
            projectId: input.projectId,
            fromAccount: keys.reserved,
            toAccount: keys.granted,
            amount: fromLedgerMinor(release.amount, input.currency),
            source: {
              type: "wallet_release_reservation",
              id: `${input.idempotencyKey}:granted:${walletCreditId}`,
            },
            metadata: {
              ...(releaseMetadata ?? {}),
              flow: "release_reservation",
              source: "granted",
              grant_id: walletCreditId,
              grant_source: release.grantSource,
              close_reason: input.closeReason,
              ...(input.sourceId ? { source_id: input.sourceId } : {}),
              reservation_id: input.reservationId,
              idempotency_key: input.idempotencyKey,
            },
          })
        }

        if (transfers.length > 0) {
          const transferResult = await this.ledger.createTransfers(transfers, tx)
          if (transferResult.err) throw this.wrapLedgerError(transferResult.err)
        }

        for (const [walletCreditId, grant] of grantsToRestore) {
          await tx
            .update(walletCredits)
            .set({ remainingAmount: grant.currentRemaining + grant.releaseAmount })
            .where(
              and(
                eq(walletCredits.id, walletCreditId),
                eq(walletCredits.projectId, input.projectId)
              )
            )
        }

        for (const leg of attribution.val.legReleases) {
          await tx
            .update(entitlementReservationFundingLegs)
            .set({ releasedAmount: leg.releasedAmount })
            .where(
              and(
                eq(entitlementReservationFundingLegs.id, leg.id),
                eq(entitlementReservationFundingLegs.projectId, input.projectId)
              )
            )
        }

        await tx
          .update(entitlementReservations)
          .set({ reconciledAt: new Date() })
          .where(
            and(
              eq(entitlementReservations.id, input.reservationId),
              eq(entitlementReservations.projectId, input.projectId)
            )
          )

        const output: ReleaseReservationOutput = {
          releasedAmount: attribution.val.releasedAmount,
          restoredGrantedAmount: attribution.val.grantedAmount,
          refundedPurchasedAmount: attribution.val.purchasedAmount,
        }

        await this.recordWalletCommandResult(tx, {
          command,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          projectId: input.projectId,
          result: output,
        })

        return Ok(output)
      })
    } catch (error) {
      return this.handleUnexpected("wallet.release_reservation_failed", error, {
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

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency,
      executor
    )
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

  public async ensureCustomerAccounts(input: {
    projectId: string
    customerId: string
    currency: Currency
  }): Promise<Result<void, UnPriceWalletError>> {
    return this.ensureCustomerSeeded(input.projectId, input.customerId, input.currency)
  }

  public async settleTopUp(
    input: SettleTopUpInput
  ): Promise<Result<SettleTopUpOutput, UnPriceWalletError>> {
    if (input.paidAmount <= 0) {
      return Err(new UnPriceWalletError({ message: "WALLET_INVALID_AMOUNT" }))
    }

    const keys = customerAccountKeys(input.customerId)

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency
    )
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

    const seeded = await this.ensureCustomerSeeded(
      input.projectId,
      input.customerId,
      input.currency
    )
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

    const command = "expireGrant"
    const payloadHash = this.commandPayloadHash({
      amount: input.amount,
      command,
      currency: input.currency,
      customerId: input.customerId,
      grantId: input.grantId,
      projectId: input.projectId,
      source: input.source,
    })

    const replay = await this.readWalletCommandResult<{ expired: boolean }>(tx, {
      command,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      projectId: input.projectId,
    })
    if (replay.err) return replay
    if (replay.val) return Ok(undefined)

    const activeReservation = await this.findActiveReservationLegForGrant(tx, {
      grantId: input.grantId,
      projectId: input.projectId,
    })
    if (activeReservation) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_GRANT_HAS_ACTIVE_RESERVATION",
          context: {
            grantId: input.grantId,
            reservationId: activeReservation.reservationId,
            stillReservedAmount: activeReservation.stillReservedAmount,
          },
        })
      )
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
    await this.recordWalletCommandResult(tx, {
      command,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      projectId: input.projectId,
      result: { expired: true },
    })
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

  public async getWalletCreditBalance(
    input: GetWalletCreditBalanceInput
  ): Promise<Result<WalletCredit | null, UnPriceWalletError>> {
    try {
      const credit = await this.db.query.walletCredits.findFirst({
        where: and(
          eq(walletCredits.id, input.walletId),
          eq(walletCredits.customerId, input.customerId),
          eq(walletCredits.projectId, input.projectId)
        ),
      })

      return Ok(credit ?? null)
    } catch (error) {
      return this.handleUnexpected("wallet.get_credit_balance_failed", error, {
        customerId: input.customerId,
        projectId: input.projectId,
        walletId: input.walletId,
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
    const { drained, allocations } = await this.drainGrantedFIFO(
      tx,
      input.customerId,
      input.projectId,
      amount,
      new Date()
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
            grant_ids: allocations
              .map((allocation) => allocation.walletCreditId)
              .filter((id): id is string => !!id),
          },
        },
        tx
      )
      if (transferResult.err) throw this.wrapLedgerError(transferResult.err)
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
    requestedAmount: number,
    effectiveAt: Date
  ): Promise<{ drained: number; allocations: FundingAllocation[] }> {
    const activeGrants = await tx.query.walletCredits.findMany({
      where: and(
        eq(walletCredits.customerId, customerId),
        eq(walletCredits.projectId, projectId),
        isNull(walletCredits.expiredAt),
        isNull(walletCredits.voidedAt),
        gt(walletCredits.remainingAmount, 0),
        // Belt-and-suspenders: skip grants whose expiry has passed even if
        // the nightly cron hasn't marked them yet
        or(isNull(walletCredits.expiresAt), gt(walletCredits.expiresAt, effectiveAt))
      ),
      orderBy: [
        // soonest-expiring first; never-expiring last
        sql`COALESCE(${walletCredits.expiresAt}, 'infinity'::timestamptz) ASC`,
        asc(walletCredits.createdAt),
      ],
    })

    let remaining = requestedAmount
    const allocations: FundingAllocation[] = []

    for (const grant of activeGrants) {
      if (remaining <= 0) break
      const drain = Math.min(remaining, grant.remainingAmount)

      await tx
        .update(walletCredits)
        .set({ remainingAmount: grant.remainingAmount - drain })
        .where(and(eq(walletCredits.id, grant.id), eq(walletCredits.projectId, grant.projectId)))

      allocations.push({
        source: "granted",
        amount: drain,
        walletCreditId: grant.id,
        grantSource: grant.source,
      })

      remaining -= drain
    }

    return { drained: requestedAmount - remaining, allocations }
  }

  private async readFundingLegs(
    tx: Transaction,
    input: { projectId: string; reservationId: string }
  ): Promise<EntitlementReservationFundingLeg[]> {
    return tx.query.entitlementReservationFundingLegs.findMany({
      where: and(
        eq(entitlementReservationFundingLegs.projectId, input.projectId),
        eq(entitlementReservationFundingLegs.reservationId, input.reservationId)
      ),
      orderBy: [asc(entitlementReservationFundingLegs.sequence)],
    })
  }

  private async nextFundingLegSequence(
    tx: Transaction,
    input: { projectId: string; reservationId: string }
  ): Promise<number> {
    const legs = await this.readFundingLegs(tx, input)
    return legs.reduce((max, leg) => Math.max(max, leg.sequence), 0) + 1
  }

  private toFundingLegRows(input: {
    projectId: string
    reservationId: string
    allocations: FundingAllocation[]
    startSequence: number
  }): Array<typeof entitlementReservationFundingLegs.$inferInsert> {
    return input.allocations.map((allocation, index) => ({
      id: newId("entitlement_reservation_funding_leg"),
      projectId: input.projectId,
      reservationId: input.reservationId,
      source: allocation.source,
      walletCreditId: allocation.source === "granted" ? (allocation.walletCreditId ?? null) : null,
      grantSource: allocation.source === "granted" ? (allocation.grantSource ?? null) : null,
      allocatedAmount: allocation.amount,
      capturedAmount: 0,
      releasedAmount: 0,
      sequence: input.startSequence + index,
    }))
  }

  private async captureFundingLegs(
    tx: Transaction,
    input: { projectId: string; reservationId: string; amount: number }
  ): Promise<Result<CapturedReservationFundingAllocation[], UnPriceWalletError>> {
    const legs = await this.readFundingLegs(tx, input)
    if (legs.length === 0 && input.amount > 0) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_METADATA_REQUIRED",
          context: { missing: "reservation_funding_legs", reservationId: input.reservationId },
        })
      )
    }

    const availableToCapture = legs.reduce((sum, leg) => sum + this.stillReservedAmount(leg), 0)
    if (availableToCapture < input.amount) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_INSUFFICIENT_FUNDS",
          context: {
            reservationId: input.reservationId,
            requestedCaptureAmount: input.amount,
            uncapturedAmount: input.amount - availableToCapture,
          },
        })
      )
    }

    let remaining = input.amount
    const allocations: CapturedReservationFundingAllocation[] = []
    for (const leg of legs) {
      if (remaining <= 0) break
      const stillReserved = this.stillReservedAmount(leg)
      if (stillReserved <= 0) continue

      const capturedNow = Math.min(remaining, stillReserved)
      allocations.push({
        amount: capturedNow,
        fundingLegId: leg.id,
        grantSource: leg.grantSource,
        source: leg.source,
        walletCreditId: leg.walletCreditId,
      })
      await tx
        .update(entitlementReservationFundingLegs)
        .set({ capturedAmount: leg.capturedAmount + capturedNow })
        .where(
          and(
            eq(entitlementReservationFundingLegs.id, leg.id),
            eq(entitlementReservationFundingLegs.projectId, leg.projectId)
          )
        )
      remaining -= capturedNow
    }

    return Ok(allocations)
  }

  private computeReservationRelease(legs: EntitlementReservationFundingLeg[]): Result<
    {
      releasedAmount: number
      grantedAmount: number
      purchasedAmount: number
      grantedByCredit: Map<string, { amount: number; grantSource: WalletCreditSource }>
      legReleases: Array<{ id: string; releasedAmount: number }>
    },
    UnPriceWalletError
  > {
    if (legs.length === 0) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_METADATA_REQUIRED",
          context: { missing: "reservation_funding_legs" },
        })
      )
    }

    let releasedAmount = 0
    let grantedAmount = 0
    let purchasedAmount = 0
    const grantedByCredit = new Map<string, { amount: number; grantSource: WalletCreditSource }>()
    const legReleases: Array<{ id: string; releasedAmount: number }> = []

    for (const leg of legs) {
      const stillReserved = this.stillReservedAmount(leg)
      if (stillReserved < 0) {
        return Err(
          new UnPriceWalletError({
            message: "WALLET_GRANT_TRACKING_DRIFT",
            context: {
              fundingLegId: leg.id,
              allocatedAmount: leg.allocatedAmount,
              capturedAmount: leg.capturedAmount,
              releasedAmount: leg.releasedAmount,
            },
          })
        )
      }
      if (stillReserved === 0) continue

      legReleases.push({
        id: leg.id,
        releasedAmount: leg.releasedAmount + stillReserved,
      })
      releasedAmount += stillReserved

      if (leg.source === "purchased") {
        purchasedAmount += stillReserved
        continue
      }

      if (!leg.walletCreditId || !this.isWalletCreditSource(leg.grantSource)) {
        return Err(
          new UnPriceWalletError({
            message: "WALLET_METADATA_REQUIRED",
            context: {
              missing: "reservation_funding_legs.wallet_credit_id",
              fundingLegId: leg.id,
            },
          })
        )
      }

      const existing = grantedByCredit.get(leg.walletCreditId)
      if (existing && existing.grantSource !== leg.grantSource) {
        return Err(
          new UnPriceWalletError({
            message: "WALLET_GRANT_TRACKING_DRIFT",
            context: { fundingLegId: leg.id, walletCreditId: leg.walletCreditId },
          })
        )
      }
      grantedByCredit.set(leg.walletCreditId, {
        amount: (existing?.amount ?? 0) + stillReserved,
        grantSource: leg.grantSource,
      })
      grantedAmount += stillReserved
    }

    return Ok({
      releasedAmount,
      grantedAmount,
      purchasedAmount,
      grantedByCredit,
      legReleases,
    })
  }

  private async findActiveReservationLegForGrant(
    tx: Transaction,
    input: { projectId: string; grantId: string }
  ): Promise<{ reservationId: string; stillReservedAmount: number } | null> {
    const rows = await tx
      .select({
        reservationId: entitlementReservationFundingLegs.reservationId,
        allocatedAmount: entitlementReservationFundingLegs.allocatedAmount,
        capturedAmount: entitlementReservationFundingLegs.capturedAmount,
        releasedAmount: entitlementReservationFundingLegs.releasedAmount,
      })
      .from(entitlementReservationFundingLegs)
      .innerJoin(
        entitlementReservations,
        and(
          eq(entitlementReservations.id, entitlementReservationFundingLegs.reservationId),
          eq(entitlementReservations.projectId, entitlementReservationFundingLegs.projectId)
        )
      )
      .where(
        and(
          eq(entitlementReservationFundingLegs.projectId, input.projectId),
          eq(entitlementReservationFundingLegs.walletCreditId, input.grantId),
          isNull(entitlementReservations.reconciledAt),
          sql`${entitlementReservationFundingLegs.allocatedAmount} - ${entitlementReservationFundingLegs.capturedAmount} - ${entitlementReservationFundingLegs.releasedAmount} > 0`
        )
      )
      .limit(1)

    const row = rows[0]
    if (!row) return null
    return {
      reservationId: row.reservationId,
      stillReservedAmount: row.allocatedAmount - row.capturedAmount - row.releasedAmount,
    }
  }

  private stillReservedAmount(leg: EntitlementReservationFundingLeg): number {
    return leg.allocatedAmount - leg.capturedAmount - leg.releasedAmount
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
   * Idempotently seeds platform funding accounts plus the customer ledger
   * bundle before any balance-changing operation. When an executor is supplied,
   * seeding runs in that transaction instead of opening nested transactions.
   */
  private async ensureCustomerSeeded(
    projectId: string,
    customerId: string,
    currency: Currency,
    executor?: DbExecutor
  ): Promise<Result<void, UnPriceWalletError>> {
    const platformResult = await this.ledger.seedPlatformAccounts(projectId, currency, executor)
    if (platformResult.err) return Err(this.wrapLedgerError(platformResult.err))

    const result = await this.ledger.ensureCustomerAccounts(customerId, currency, executor)
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

  private normalizeJsonMetadata(
    metadata: Record<string, unknown> | undefined
  ): Record<string, unknown> | null {
    if (!metadata) return null

    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        normalized[key] = value
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : null
  }

  private async readWalletCommandResult<T extends object>(
    tx: Transaction,
    input: {
      projectId: string
      idempotencyKey: string
      command: string
      payloadHash: string
    }
  ): Promise<Result<T | null, UnPriceWalletError>> {
    const existing = await tx.query.walletCommandIdempotency.findFirst({
      where: and(
        eq(walletCommandIdempotency.projectId, input.projectId),
        eq(walletCommandIdempotency.idempotencyKey, input.idempotencyKey)
      ),
    })

    if (!existing) return Ok(null)
    if (existing.command !== input.command || existing.payloadHash !== input.payloadHash) {
      return Err(
        new UnPriceWalletError({
          message: "WALLET_IDEMPOTENCY_CONFLICT",
          context: {
            idempotencyKey: input.idempotencyKey,
            command: input.command,
            existingCommand: existing.command,
          },
        })
      )
    }

    return Ok(existing.result as T)
  }

  private async recordWalletCommandResult(
    tx: Transaction,
    input: {
      projectId: string
      idempotencyKey: string
      command: string
      payloadHash: string
      result: object
    }
  ): Promise<void> {
    await tx.insert(walletCommandIdempotency).values({
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      command: input.command,
      payloadHash: input.payloadHash,
      result: input.result as Record<string, unknown>,
    })
  }

  private commandPayloadHash(value: Record<string, unknown>): string {
    return JSON.stringify(this.sortObject(value))
  }

  private sortObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sortObject(item))
    if (!value || typeof value !== "object") return value

    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = this.sortObject((value as Record<string, unknown>)[key])
        return out
      }, {})
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
  captureUsage: "wallet_capture_usage",
  extendGranted: "wallet_extend_granted",
  extendPurchased: "wallet_extend_purchased",
  releaseReservation: "wallet_release_reservation",
  adjust: "wallet_adjust",
  topup: "wallet_topup",
  expireGrant: "wallet_expire_grant",
} as const satisfies Record<string, LedgerSource["type"]>
