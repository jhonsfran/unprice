import type { BillingUsageSnapshot } from "@unprice/services/billing"
import type { GrantConsumptionState } from "@unprice/services/entitlements"
import type { ReservationCloseReason } from "@unprice/services/wallet"
import type {
  ApplyBatchMetrics,
  ApplyBatchResultRow,
  BatchIdempotencyEntry,
  RefillTrigger,
  WalletReservationSnapshot,
} from "./contracts"
import { createApplyBatchMetrics } from "./contracts"
import type { MeterStateDraft } from "./meter-state-adapter"
import { unique } from "./utils"

export type OptimizedBatchWriteMetrics = Pick<
  ApplyBatchMetrics,
  | "grant_window_write_count"
  | "idempotency_event_count"
  | "idempotency_insert_count"
  | "meter_state_write_count"
  | "outbox_fact_count"
  | "outbox_insert_count"
  | "wallet_reservation_write_count"
>

export type OptimizedBatchCommitPayload = {
  idempotencyEntries: BatchIdempotencyEntry[]
  meterStates: Map<string, MeterStateDraft>
  refillTrigger: RefillTrigger | null
  reservationCloseReason: ReservationCloseReason | null
  touchedGrantStates: Map<string, GrantConsumptionState>
  wallet: WalletReservationSnapshot
  walletDirty: boolean
}

export type OptimizedBatchDraft = {
  billingUsageSnapshots: Map<string, BillingUsageSnapshot>
  grantStates: GrantConsumptionState[]
  meterStates: Map<string, MeterStateDraft>
  readMeterState(meterKey: string): MeterStateDraft
  metrics: ApplyBatchMetrics
  results: ApplyBatchResultRow[]
  touchedGrantStates: Map<string, GrantConsumptionState>
  wallet: WalletReservationSnapshot
  walletDirty: boolean
  refillTrigger: RefillTrigger | null
  reservationCloseReason: ReservationCloseReason | null
  lookupStagedResult(eventId: string): BatchIdempotencyEntry | undefined
  stageIdempotencyEntry(entry: BatchIdempotencyEntry): void
  hasDurableMutations(): boolean
  toCommitPayload(): OptimizedBatchCommitPayload
}

export function createOptimizedBatchDraft(params: {
  grantStates: GrantConsumptionState[]
  meterStates: Map<string, MeterStateDraft>
  wallet: WalletReservationSnapshot
}): OptimizedBatchDraft {
  const stagedResultsByKey = new Map<string, BatchIdempotencyEntry>()
  const idempotencyEntries: BatchIdempotencyEntry[] = []
  const draft: OptimizedBatchDraft = {
    billingUsageSnapshots: new Map(),
    grantStates: params.grantStates.map((state) => ({ ...state })),
    meterStates: new Map([...params.meterStates].map(([key, state]) => [key, { ...state }])),
    readMeterState(meterKey) {
      const state = draft.meterStates.get(meterKey)
      if (!state) throw new Error(`Missing staged meter state for ${meterKey}`)
      return state
    },
    metrics: createApplyBatchMetrics(),
    results: [],
    touchedGrantStates: new Map<string, GrantConsumptionState>(),
    wallet: params.wallet ? { ...params.wallet } : null,
    walletDirty: false,
    refillTrigger: null,
    reservationCloseReason: null,
    lookupStagedResult(eventId) {
      return stagedResultsByKey.get(eventId)
    },
    stageIdempotencyEntry(entry) {
      idempotencyEntries.push(entry)
      stagedResultsByKey.set(entry.eventId, entry)
    },
    hasDurableMutations() {
      return (
        idempotencyEntries.length > 0 ||
        [...draft.meterStates.values()].some((state) => state.dirty) ||
        draft.touchedGrantStates.size > 0 ||
        draft.walletDirty
      )
    },
    toCommitPayload() {
      return {
        idempotencyEntries,
        meterStates: draft.meterStates,
        refillTrigger: draft.refillTrigger,
        reservationCloseReason: draft.reservationCloseReason,
        touchedGrantStates: draft.touchedGrantStates,
        wallet: draft.wallet,
        walletDirty: draft.walletDirty,
      }
    },
  }
  return draft
}

export function createOptimizedBatchWriteMetrics(params: {
  idempotencyEntryCount: number
  meterStateDirty: boolean
  meterStateExists: boolean
  touchedGrantPeriodKeys: string[]
  walletDirty: boolean
  walletPresent: boolean
}): OptimizedBatchWriteMetrics {
  return {
    meter_state_write_count: params.meterStateDirty ? (params.meterStateExists ? 1 : 2) : 0,
    grant_window_write_count: unique(params.touchedGrantPeriodKeys).length,
    wallet_reservation_write_count: params.walletDirty && params.walletPresent ? 1 : 0,
    outbox_insert_count: 0,
    outbox_fact_count: 0,
    idempotency_insert_count: params.idempotencyEntryCount > 0 ? 1 : 0,
    idempotency_event_count: params.idempotencyEntryCount,
  }
}
