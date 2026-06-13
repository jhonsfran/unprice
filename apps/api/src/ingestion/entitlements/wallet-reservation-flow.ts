import type { WalletReservationSnapshot } from "./contracts"

export type ReservationInvoiceContext = {
  billingPeriodId: string
  cycleEndAt: number
  cycleStartAt: number
  featurePlanVersionItemId: string
  featureSlug: string
  sourceId: string
  statementKey: string
}

export function hasPendingWalletFlush(
  window: Pick<
    NonNullable<WalletReservationSnapshot>,
    "flushSeq" | "pendingFlushSeq" | "refillInFlight" | "reservationId"
  > | null
): boolean {
  return Boolean(
    window?.reservationId &&
      (window.refillInFlight ||
        (window.pendingFlushSeq !== null &&
          window.pendingFlushSeq !== undefined &&
          window.pendingFlushSeq > window.flushSeq))
  )
}

export function isReservationInvoiceContextMissing(
  window: Pick<
    NonNullable<WalletReservationSnapshot>,
    | "billingPeriodId"
    | "cycleEndAt"
    | "cycleStartAt"
    | "featurePlanVersionItemId"
    | "featureSlug"
    | "statementKey"
  >
): boolean {
  return (
    !window.billingPeriodId ||
    window.cycleEndAt === null ||
    window.cycleStartAt === null ||
    !window.featurePlanVersionItemId ||
    !window.featureSlug ||
    !window.statementKey
  )
}

export function requireReservationInvoiceContext(
  window: Pick<
    NonNullable<WalletReservationSnapshot>,
    | "billingPeriodId"
    | "cycleEndAt"
    | "cycleStartAt"
    | "featurePlanVersionItemId"
    | "featureSlug"
    | "reservationId"
    | "statementKey"
  >
): ReservationInvoiceContext {
  const {
    billingPeriodId,
    cycleEndAt,
    cycleStartAt,
    featurePlanVersionItemId,
    featureSlug,
    statementKey,
  } = window

  if (
    !billingPeriodId ||
    cycleEndAt === null ||
    cycleStartAt === null ||
    !featurePlanVersionItemId ||
    !featureSlug ||
    !statementKey
  ) {
    throw new Error(`Wallet reservation ${window.reservationId} is missing billing invoice context`)
  }

  return {
    billingPeriodId,
    cycleEndAt,
    cycleStartAt,
    featurePlanVersionItemId,
    featureSlug,
    sourceId: `${billingPeriodId}:${featurePlanVersionItemId}`,
    statementKey,
  }
}
