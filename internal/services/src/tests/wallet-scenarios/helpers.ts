import type { Currency } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { ReservationCloseReason, UnPriceWalletError, WalletService } from "../../wallet"

export interface TestFlushReservationInput {
  projectId: string
  customerId: string
  currency: Currency
  reservationId: string
  flushSeq: number
  flushAmount: number
  refillChunkAmount: number
  statementKey: string
  final: boolean
  billingPeriodId?: string
  closeReason?: ReservationCloseReason
  kind?: string
  metadata?: Record<string, unknown>
  sourceId?: string
  effectiveAt?: Date
}

export interface TestFlushReservationOutput {
  grantedAmount: number
  flushedAmount: number
  refundedAmount: number
}

export async function flushReservationForTest(
  wallet: WalletService,
  input: TestFlushReservationInput
): Promise<Result<TestFlushReservationOutput, UnPriceWalletError>> {
  const captured = await wallet.captureReservationUsage({
    projectId: input.projectId,
    customerId: input.customerId,
    currency: input.currency,
    reservationId: input.reservationId,
    flushSeq: input.flushSeq,
    amount: input.flushAmount,
    statementKey: input.statementKey,
    ...(input.billingPeriodId ? { billingPeriodId: input.billingPeriodId } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    metadata: input.metadata,
    sourceId: input.sourceId,
  })
  if (captured.err) return Err(captured.err)

  if (input.final) {
    const closeReason = input.closeReason ?? "manual"
    const released = await wallet.releaseReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency,
      reservationId: input.reservationId,
      closeReason,
      idempotencyKey: `release:${input.reservationId}:${closeReason}`,
      metadata: input.metadata,
      sourceId: input.sourceId,
    })
    if (released.err) return Err(released.err)

    return Ok({
      grantedAmount: 0,
      flushedAmount: captured.val.capturedAmount,
      refundedAmount: released.val.refundedPurchasedAmount,
    })
  }

  const extended = await wallet.extendReservation({
    projectId: input.projectId,
    customerId: input.customerId,
    currency: input.currency,
    reservationId: input.reservationId,
    flushSeq: input.flushSeq,
    requestedAmount: input.refillChunkAmount,
    statementKey: input.statementKey,
    metadata: input.metadata,
    sourceId: input.sourceId,
    effectiveAt: input.effectiveAt,
  })
  if (extended.err) return Err(extended.err)

  return Ok({
    grantedAmount: extended.val.grantedAmount,
    flushedAmount: captured.val.capturedAmount,
    refundedAmount: 0,
  })
}
