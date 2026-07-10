import type { GrantConsumptionState } from "@unprice/services/entitlements"
import { DO_IDEMPOTENCY_TTL_MS, computeGrantPeriodBucket } from "@unprice/services/entitlements"
import { idempotencyEntryToApplyResult } from "../batch-apply-helpers"
import type {
  ActiveGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  WalletReservationSnapshot,
} from "../contracts"
import type {
  EnsureWalletReservationParams,
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
  WalletReservationPatch,
} from "../ports"

type MeterStateRow = { usage: number; updatedAt: number | null; createdAt: number }

export class InMemoryEntitlementWindowStore implements EntitlementWindowStateStore {
  meterStates = new Map<string, MeterStateRow>()
  grantStates = new Map<string, GrantConsumptionState>()
  idempotency = new Map<string, BatchIdempotencyEntry>()
  walletRow: NonNullable<WalletReservationSnapshot> | null = null

  constructor(private readonly onStateChanged: () => void = () => {}) {}

  atomically<T>(fn: (tx: EntitlementWindowStateOps) => T): T {
    const snapshot = {
      meterStates: new Map([...this.meterStates].map(([k, v]) => [k, { ...v }])),
      grantStates: new Map([...this.grantStates].map(([k, v]) => [k, { ...v }])),
      idempotency: new Map(this.idempotency),
      walletRow: this.walletRow ? { ...this.walletRow } : null,
    }
    try {
      return fn(this)
    } catch (error) {
      this.meterStates = snapshot.meterStates
      this.grantStates = snapshot.grantStates
      this.idempotency = snapshot.idempotency
      this.walletRow = snapshot.walletRow
      throw error
    }
  }

  ensureMeterState(params: { meterKey: string; createdAt: number }): void {
    if (this.meterStates.has(params.meterKey)) return
    this.meterStates.set(params.meterKey, {
      usage: 0,
      updatedAt: null,
      createdAt: params.createdAt,
    })
  }

  readMeterStateDraft(meterKey: string, createdAt: number) {
    const row = this.meterStates.get(meterKey)
    return {
      createdAt,
      dirty: false,
      exists: Boolean(row),
      meterKey,
      updatedAt: row?.updatedAt ?? null,
      usage: row?.usage ?? 0,
    }
  }

  writeMeterState(params: {
    meterKey: string
    createdAt: number
    usage: number
    updatedAt: number | null
  }): void {
    this.ensureMeterState(params)
    const row = this.meterStates.get(params.meterKey)
    if (!row) return
    row.usage = params.usage
    row.updatedAt = params.updatedAt
  }

  readGrantStatesForActiveGrants(
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    return this.readGrantStatesForBatch(grants, [timestamp])
  }

  readGrantStatesForBatch(
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    const bucketKeys = new Set(
      timestamps.flatMap((timestamp) =>
        grants
          .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
          .filter((key): key is string => typeof key === "string")
      )
    )
    return [...this.grantStates.values()]
      .filter((state) => bucketKeys.has(state.bucketKey))
      .map((state) => ({ ...state }))
  }

  writeGrantConsumptions(states: Iterable<GrantConsumptionState>): number {
    const periodKeys = new Set<string>()
    for (const state of states) {
      this.grantStates.set(state.bucketKey, { ...state })
      periodKeys.add(state.periodKey)
    }
    if (periodKeys.size > 0) this.onStateChanged()
    return periodKeys.size
  }

  lookupCachedIdempotencyResult(eventId: string): ApplyResult | null {
    const entry = this.idempotency.get(eventId)
    return entry ? idempotencyEntryToApplyResult(entry) : null
  }

  lookupCachedIdempotencyResults(eventIds: string[]): Map<string, BatchIdempotencyEntry> {
    const results = new Map<string, BatchIdempotencyEntry>()
    for (const eventId of eventIds) {
      const entry = this.idempotency.get(eventId)
      if (entry) results.set(eventId, entry)
    }
    return results
  }

  writeBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    for (const entry of entries) {
      this.idempotency.set(entry.eventId, entry)
    }
  }

  recordBatchIdempotencyResults(_entries: BatchIdempotencyEntry[]): void {
    // Durable map doubles as the read cache in this in-memory store.
  }

  cleanupStaleIdempotencyKeys(now: number): number {
    const cutoff = now - DO_IDEMPOTENCY_TTL_MS
    let removed = 0
    for (const [eventId, entry] of this.idempotency) {
      if (entry.createdAt < cutoff) {
        this.idempotency.delete(eventId)
        removed++
      }
    }
    return removed
  }

  readLifecycleEndAt(): number | null {
    const ends: number[] = []
    for (const state of this.grantStates.values()) {
      if (Number.isFinite(state.periodEndAt)) ends.push(state.periodEndAt)
    }
    if (typeof this.walletRow?.reservationEndAt === "number") {
      ends.push(this.walletRow.reservationEndAt)
    }
    return ends.length > 0 ? Math.max(...ends) : null
  }

  readWalletReservation(): WalletReservationSnapshot {
    return this.walletRow ? { ...this.walletRow } : null
  }

  ensureWalletReservation(params: EnsureWalletReservationParams): void {
    this.walletRow = {
      reservationId: null,
      allocationAmount: 0,
      consumedAmount: 0,
      flushedAmount: 0,
      consumedQuantity: 0,
      flushedQuantity: 0,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      targetReservationAmount: 0,
      spendEwmaAmount: 0,
      lastRateSampledAtMs: null,
      maxEventCostAmount: 0,
      pendingRefillAmount: 0,
      pendingFlushAmount: null,
      pendingFlushQuantity: null,
      refillInFlight: false,
      flushSeq: 0,
      pendingFlushSeq: null,
      pendingFlushFinal: false,
      lastEventAt: null,
      lastFlushedAt: null,
      deletionRequested: false,
      recoveryRequired: false,
      ...(this.walletRow ?? {}),
      projectId: params.projectId,
      customerId: params.customerId,
      currency: params.currency,
      reservationEndAt: params.reservationEndAt,
      billingPeriodId: params.billingPeriodId ?? null,
      cycleEndAt: params.cycleEndAt ?? null,
      cycleStartAt: params.cycleStartAt ?? null,
      featurePlanVersionItemId: params.featurePlanVersionItemId ?? null,
      featureSlug: params.featureSlug ?? null,
      statementKey: params.statementKey ?? null,
    }
  }

  updateWalletReservation(patch: WalletReservationPatch): void {
    // Mirrors the SQLite singleton-row semantics: an update with no row is a no-op.
    if (!this.walletRow) return
    Object.assign(this.walletRow, patch)
  }
}
