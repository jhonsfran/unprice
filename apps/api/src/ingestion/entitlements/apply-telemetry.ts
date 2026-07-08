import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { computeBatchReservationHeadroom } from "./batch-apply-helpers"
import type { EntitlementWindowBatchReservationUnderfundedError, RefillTrigger } from "./contracts"

// Pure log/metrics helpers shared by the entitlement window processor. No
// storage or platform dependencies — safe for any backend.

export type OptimizedBatchWalletRetryOutcome =
  | "already_funded"
  | "refilled"
  | "max_outstanding_reached"
  | "unavailable"

export type OptimizedBatchWalletDiagnostics = {
  emptyAfterRefillEventIds: string[]
  emptyAfterRefillLastRemainingAmount: number | null
  emptyAfterRefillLastRequiredAmount: number | null
  retryCount: number
  retryEventIds: string[]
  retryLastCurrentRemainingAmount: number | null
  retryLastEffectiveCostAmount: number | null
  retryLastMeterKey: string | null
  retryLastMeterSlug: string | null
  retryLastPersistedConsumedAmount: number | null
  retryLastRequiredHeadroomAmount: number | null
  retryLastReservationId: string | null
  retryLastStagedConsumedAmount: number | null
  retryOutcomes: OptimizedBatchWalletRetryOutcome[]
}

export function createOptimizedBatchWalletDiagnostics(): OptimizedBatchWalletDiagnostics {
  return {
    emptyAfterRefillEventIds: [],
    emptyAfterRefillLastRemainingAmount: null,
    emptyAfterRefillLastRequiredAmount: null,
    retryCount: 0,
    retryEventIds: [],
    retryLastCurrentRemainingAmount: null,
    retryLastEffectiveCostAmount: null,
    retryLastMeterKey: null,
    retryLastMeterSlug: null,
    retryLastPersistedConsumedAmount: null,
    retryLastRequiredHeadroomAmount: null,
    retryLastReservationId: null,
    retryLastStagedConsumedAmount: null,
    retryOutcomes: [],
  }
}

export function batchWalletDiagnosticsLogFields(
  diagnostics: OptimizedBatchWalletDiagnostics,
  currency: string | null
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    batch_wallet_underfunded_retry_count: diagnostics.retryCount,
    batch_wallet_underfunded_event_ids: diagnostics.retryEventIds,
    batch_wallet_underfunded_refill_outcomes: diagnostics.retryOutcomes,
    batch_wallet_underfunded_last_event_id:
      diagnostics.retryEventIds[diagnostics.retryEventIds.length - 1] ?? null,
    batch_wallet_underfunded_last_meter_key: diagnostics.retryLastMeterKey,
    batch_wallet_underfunded_last_meter_slug: diagnostics.retryLastMeterSlug,
    batch_wallet_underfunded_last_reservation_id: diagnostics.retryLastReservationId,
    batch_wallet_underfunded_last_persisted_consumed_amount:
      diagnostics.retryLastPersistedConsumedAmount,
    batch_wallet_underfunded_last_staged_consumed_amount: diagnostics.retryLastStagedConsumedAmount,
    batch_wallet_underfunded_last_effective_cost_amount: diagnostics.retryLastEffectiveCostAmount,
    batch_wallet_underfunded_last_required_headroom_amount:
      diagnostics.retryLastRequiredHeadroomAmount,
    batch_wallet_underfunded_last_remaining_amount: diagnostics.retryLastCurrentRemainingAmount,
    batch_wallet_empty_after_refill_count: diagnostics.emptyAfterRefillEventIds.length,
    batch_wallet_empty_after_refill_event_ids: diagnostics.emptyAfterRefillEventIds,
    batch_wallet_empty_after_refill_last_event_id:
      diagnostics.emptyAfterRefillEventIds[diagnostics.emptyAfterRefillEventIds.length - 1] ?? null,
    batch_wallet_empty_after_refill_last_required_amount:
      diagnostics.emptyAfterRefillLastRequiredAmount,
    batch_wallet_empty_after_refill_last_remaining_amount:
      diagnostics.emptyAfterRefillLastRemainingAmount,
  }

  addLedgerAmountDisplayFields(fields, currency, [
    "batch_wallet_underfunded_last_persisted_consumed_amount",
    "batch_wallet_underfunded_last_staged_consumed_amount",
    "batch_wallet_underfunded_last_effective_cost_amount",
    "batch_wallet_underfunded_last_required_headroom_amount",
    "batch_wallet_underfunded_last_remaining_amount",
    "batch_wallet_empty_after_refill_last_required_amount",
    "batch_wallet_empty_after_refill_last_remaining_amount",
  ])

  return fields
}

export function addLedgerAmountDisplayFields(
  fields: Record<string, unknown>,
  currency: string | null | undefined,
  amountFieldNames: string[]
): void {
  for (const fieldName of amountFieldNames) {
    const display = formatLedgerMinorForLog(fields[fieldName], currency)
    if (display !== null) {
      fields[`${fieldName}_display`] = display
    }
  }
}

function formatLedgerMinorForLog(
  value: unknown,
  currency: string | null | undefined
): string | null {
  if (!currency || typeof value !== "number" || !Number.isFinite(value)) {
    return null
  }

  try {
    return toDecimal(fromLedgerMinor(value, currency), ({ value: amount, currency: resolved }) =>
      formatMoney(amount, resolved.code)
    )
  } catch {
    return null
  }
}

export function readLogCurrency(fields: Record<string, unknown>): string | null {
  const currency = fields.currency
  return typeof currency === "string" && currency.length > 0 ? currency : null
}

export function recordBatchWalletUnderfundedRetry(params: {
  diagnostics: OptimizedBatchWalletDiagnostics
  error: EntitlementWindowBatchReservationUnderfundedError
  outcome: OptimizedBatchWalletRetryOutcome
}): void {
  const { diagnostics, error, outcome } = params
  const headroom = computeBatchReservationHeadroom({
    persistedConsumedAmount: error.params.persistedConsumedAmount,
    stagedConsumedAmount: error.params.stagedConsumedAmount,
    currentEventEffectiveCostAmount: error.params.effectiveCostAmount,
  })

  diagnostics.retryCount++
  diagnostics.retryEventIds.push(error.params.eventId)
  diagnostics.retryOutcomes.push(outcome)
  diagnostics.retryLastCurrentRemainingAmount = error.params.currentRemainingAmount
  diagnostics.retryLastEffectiveCostAmount = error.params.effectiveCostAmount
  diagnostics.retryLastMeterKey = error.params.meterKey
  diagnostics.retryLastMeterSlug = error.params.meterSlug
  diagnostics.retryLastPersistedConsumedAmount = error.params.persistedConsumedAmount
  diagnostics.retryLastRequiredHeadroomAmount = headroom.requiredHeadroomAmount
  diagnostics.retryLastReservationId = error.params.reservationId
  diagnostics.retryLastStagedConsumedAmount = error.params.stagedConsumedAmount
}

export type SingleApplyExecutionMetrics = {
  duplicateCount: number
  grantAllocationCount: number
  grantWindowWriteCount: number
  idempotencyInsertCount: number
  insertedFactCount: number
  meterStateWriteCount: number
  outboxFactCount: number
  outboxInsertCount: number
  pricedFactCount: number
  refillTrigger: RefillTrigger | null
  reservationEngaged: boolean
  totalCost: number
  walletReservationWriteCount: number
}

export function createSingleApplyExecutionMetrics(): SingleApplyExecutionMetrics {
  return {
    duplicateCount: 0,
    grantAllocationCount: 0,
    grantWindowWriteCount: 0,
    idempotencyInsertCount: 0,
    insertedFactCount: 0,
    meterStateWriteCount: 0,
    outboxFactCount: 0,
    outboxInsertCount: 0,
    pricedFactCount: 0,
    refillTrigger: null,
    reservationEngaged: false,
    totalCost: 0,
    walletReservationWriteCount: 0,
  }
}
