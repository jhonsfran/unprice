import type { GrantConsumptionState } from "@unprice/services/entitlements"
import { DO_IDEMPOTENCY_TTL_MS, computeGrantPeriodBucket } from "@unprice/services/entitlements"
import { asc, desc, eq, inArray, lt } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import type { z } from "zod"
import { idempotencyEntryToApplyResult } from "./batch-apply-helpers"
import {
  APPLY_BATCH_SIZE_LIMIT,
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  WALLET_RESERVATION_ROW_ID,
} from "./constants"
import type {
  ActiveGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  WalletReservationSnapshot,
} from "./contracts"
import {
  batchIdempotencyEntryListSchema,
  compactGrantConsumptionStateListSchema,
} from "./contracts"
import {
  entitlementPeriodUsageTable,
  idempotencyKeyBatchesTable,
  meterStateTable,
  type schema,
  walletReservationTable,
} from "./db/schema"
import type { MeterStateDraft } from "./meter-state-adapter"
import type {
  EnsureWalletReservationParams,
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
  WalletReservationPatch,
} from "./ports"
import { unique } from "./utils"

// ---------------------------------------------------------------------------
// Public pure helpers
// ---------------------------------------------------------------------------

export type WarningLogger = {
  warn(message: string, fields: Record<string, unknown>): void
}

export function parseCompactGrantStates(
  raw: string,
  schema: z.ZodType<GrantConsumptionState[]>,
  logger: WarningLogger
): GrantConsumptionState[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn("skipping unparsable compact entitlement period state", {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    logger.warn("skipping malformed compact entitlement period state", {
      error: result.error.message,
    })
    return []
  }

  return result.data
}

export function replaceGrantConsumptionState(
  states: GrantConsumptionState[],
  state: GrantConsumptionState
): void {
  const index = states.findIndex((candidate) => candidate.bucketKey === state.bucketKey)
  if (index >= 0) {
    states[index] = state
    return
  }

  states.push(state)
}

export function selectGrantStatesForActiveGrants(
  grants: ActiveGrantInput[],
  states: GrantConsumptionState[],
  timestamp: number
): GrantConsumptionState[] {
  const activeBucketKeys = new Set(
    grants
      .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
      .filter((key): key is string => typeof key === "string" && key.length > 0)
  )

  return states.filter((state) => activeBucketKeys.has(state.bucketKey))
}

// ---------------------------------------------------------------------------
// Durable SQLite store
//
// SQLite (Durable Object) implementation of EntitlementWindowStateStore. The
// Durable Object gives us single-writer serialization; `atomically` maps to a
// synchronous SQLite transaction on the same handle, and direct port methods
// run as individually atomic statements.
// ---------------------------------------------------------------------------

type SqliteHandle = DrizzleSqliteDODatabase<typeof schema>

export class EntitlementWindowStore implements EntitlementWindowStateStore {
  private batchIdempotencyResults: Map<string, BatchIdempotencyEntry> | null = null

  constructor(
    private readonly db: SqliteHandle,
    private readonly logger: WarningLogger,
    private readonly onStateChanged: () => void
  ) {}

  // -------------------------------------------------------------------
  // Atomic command boundary
  // -------------------------------------------------------------------

  atomically<T>(fn: (tx: EntitlementWindowStateOps) => T): T {
    return this.db.transaction((tx) => fn(this.bindOps(tx)))
  }

  private bindOps(handle: SqliteHandle): EntitlementWindowStateOps {
    return {
      ensureMeterState: (params) => this.ensureMeterStateIn(handle, params),
      readMeterStateDraft: (meterKey, createdAt) =>
        this.readMeterStateDraftIn(handle, meterKey, createdAt),
      writeMeterState: (params) => this.writeMeterStateIn(handle, params),
      readGrantStatesForActiveGrants: (grants, timestamp) =>
        this.readGrantStatesForActiveGrantsIn(handle, grants, timestamp),
      readGrantStatesForBatch: (grants, timestamps) =>
        this.readGrantStatesForBatchIn(handle, grants, timestamps),
      writeGrantConsumptions: (states) => this.writeGrantConsumptionsIn(handle, states),
      lookupCachedIdempotencyResult: (eventId) => this.lookupCachedIdempotencyResult(eventId),
      lookupCachedIdempotencyResults: (eventIds) => this.lookupCachedIdempotencyResults(eventIds),
      writeBatchIdempotencyResults: (entries) =>
        this.writeBatchIdempotencyResultsIn(handle, entries),
      readWalletReservation: () => this.readWalletReservationIn(handle),
      ensureWalletReservation: (params) => this.ensureWalletReservationIn(handle, params),
      updateWalletReservation: (patch) => this.updateWalletReservationIn(handle, patch),
    }
  }

  // -------------------------------------------------------------------
  // Meter state
  // -------------------------------------------------------------------

  ensureMeterState(params: { meterKey: string; createdAt: number }): void {
    this.ensureMeterStateIn(this.db, params)
  }

  readMeterStateDraft(meterKey: string, createdAt: number): MeterStateDraft {
    return this.readMeterStateDraftIn(this.db, meterKey, createdAt)
  }

  writeMeterState(params: {
    meterKey: string
    createdAt: number
    usage: number
    updatedAt: number | null
  }): void {
    this.writeMeterStateIn(this.db, params)
  }

  private ensureMeterStateIn(
    handle: SqliteHandle,
    params: { meterKey: string; createdAt: number }
  ): void {
    handle
      .insert(meterStateTable)
      .values({
        meterKey: params.meterKey,
        usage: 0,
        updatedAt: null,
        createdAt: params.createdAt,
      })
      .onConflictDoNothing({ target: meterStateTable.meterKey })
      .run()
  }

  private readMeterStateDraftIn(
    handle: SqliteHandle,
    meterKey: string,
    createdAt: number
  ): MeterStateDraft {
    const row = handle
      .select({
        usage: meterStateTable.usage,
        updatedAt: meterStateTable.updatedAt,
      })
      .from(meterStateTable)
      .where(eq(meterStateTable.meterKey, meterKey))
      .get()

    return {
      createdAt,
      dirty: false,
      exists: Boolean(row),
      meterKey,
      updatedAt: row?.updatedAt ?? null,
      usage: Number(row?.usage ?? 0),
    }
  }

  private writeMeterStateIn(
    handle: SqliteHandle,
    params: { meterKey: string; createdAt: number; usage: number; updatedAt: number | null }
  ): void {
    this.ensureMeterStateIn(handle, { meterKey: params.meterKey, createdAt: params.createdAt })
    handle
      .update(meterStateTable)
      .set({
        usage: params.usage,
        updatedAt: params.updatedAt,
      })
      .where(eq(meterStateTable.meterKey, params.meterKey))
      .run()
  }

  // -------------------------------------------------------------------
  // Wallet reservation
  // -------------------------------------------------------------------

  readWalletReservation(): WalletReservationSnapshot {
    return this.readWalletReservationIn(this.db)
  }

  ensureWalletReservation(params: EnsureWalletReservationParams): void {
    this.ensureWalletReservationIn(this.db, params)
  }

  updateWalletReservation(patch: WalletReservationPatch): void {
    this.updateWalletReservationIn(this.db, patch)
  }

  private ensureWalletReservationIn(
    handle: SqliteHandle,
    params: EnsureWalletReservationParams
  ): void {
    handle
      .insert(walletReservationTable)
      .values({
        id: WALLET_RESERVATION_ROW_ID,
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
      })
      .onConflictDoNothing({ target: walletReservationTable.id })
      .run()

    handle
      .update(walletReservationTable)
      .set({
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
      })
      .run()
  }

  // The singleton row is the only row in the table, so updates never need a
  // WHERE clause. Patches come straight from the processor's staged state.
  private updateWalletReservationIn(handle: SqliteHandle, patch: WalletReservationPatch): void {
    handle.update(walletReservationTable).set(patch).run()
  }

  private readWalletReservationIn(handle: SqliteHandle): WalletReservationSnapshot {
    const row = handle
      .select({
        projectId: walletReservationTable.projectId,
        customerId: walletReservationTable.customerId,
        currency: walletReservationTable.currency,
        reservationEndAt: walletReservationTable.reservationEndAt,
        billingPeriodId: walletReservationTable.billingPeriodId,
        cycleEndAt: walletReservationTable.cycleEndAt,
        cycleStartAt: walletReservationTable.cycleStartAt,
        featurePlanVersionItemId: walletReservationTable.featurePlanVersionItemId,
        featureSlug: walletReservationTable.featureSlug,
        statementKey: walletReservationTable.statementKey,
        reservationId: walletReservationTable.reservationId,
        allocationAmount: walletReservationTable.allocationAmount,
        consumedAmount: walletReservationTable.consumedAmount,
        flushedAmount: walletReservationTable.flushedAmount,
        consumedQuantity: walletReservationTable.consumedQuantity,
        flushedQuantity: walletReservationTable.flushedQuantity,
        refillThresholdBps: walletReservationTable.refillThresholdBps,
        refillChunkAmount: walletReservationTable.refillChunkAmount,
        targetReservationAmount: walletReservationTable.targetReservationAmount,
        spendEwmaAmount: walletReservationTable.spendEwmaAmount,
        lastRateSampledAtMs: walletReservationTable.lastRateSampledAtMs,
        maxEventCostAmount: walletReservationTable.maxEventCostAmount,
        pendingRefillAmount: walletReservationTable.pendingRefillAmount,
        pendingFlushAmount: walletReservationTable.pendingFlushAmount,
        pendingFlushQuantity: walletReservationTable.pendingFlushQuantity,
        refillInFlight: walletReservationTable.refillInFlight,
        flushSeq: walletReservationTable.flushSeq,
        pendingFlushSeq: walletReservationTable.pendingFlushSeq,
        pendingFlushFinal: walletReservationTable.pendingFlushFinal,
        lastEventAt: walletReservationTable.lastEventAt,
        lastFlushedAt: walletReservationTable.lastFlushedAt,
        deletionRequested: walletReservationTable.deletionRequested,
        recoveryRequired: walletReservationTable.recoveryRequired,
      })
      .from(walletReservationTable)
      .get()

    if (!row) return null

    return {
      projectId: row.projectId ?? null,
      customerId: row.customerId ?? null,
      currency: String(row.currency ?? ""),
      reservationEndAt: row.reservationEndAt ?? null,
      billingPeriodId: row.billingPeriodId ?? null,
      cycleEndAt: row.cycleEndAt ?? null,
      cycleStartAt: row.cycleStartAt ?? null,
      featurePlanVersionItemId: row.featurePlanVersionItemId ?? null,
      featureSlug: row.featureSlug ?? null,
      statementKey: row.statementKey ?? null,
      reservationId: row.reservationId ?? null,
      allocationAmount: Number(row.allocationAmount ?? 0),
      consumedAmount: Number(row.consumedAmount ?? 0),
      flushedAmount: Number(row.flushedAmount ?? 0),
      consumedQuantity: Number(row.consumedQuantity ?? 0),
      flushedQuantity: Number(row.flushedQuantity ?? 0),
      refillThresholdBps: Number(row.refillThresholdBps ?? 0),
      refillChunkAmount: Number(row.refillChunkAmount ?? 0),
      targetReservationAmount: Number(row.targetReservationAmount ?? 0),
      spendEwmaAmount: Number(row.spendEwmaAmount ?? 0),
      lastRateSampledAtMs: row.lastRateSampledAtMs ?? null,
      maxEventCostAmount: Number(row.maxEventCostAmount ?? 0),
      pendingRefillAmount: Number(row.pendingRefillAmount ?? 0),
      pendingFlushAmount:
        row.pendingFlushAmount === null || row.pendingFlushAmount === undefined
          ? null
          : Number(row.pendingFlushAmount),
      pendingFlushQuantity:
        row.pendingFlushQuantity === null || row.pendingFlushQuantity === undefined
          ? null
          : Number(row.pendingFlushQuantity),
      refillInFlight: Boolean(row.refillInFlight),
      flushSeq: Number(row.flushSeq ?? 0),
      pendingFlushSeq: row.pendingFlushSeq ?? null,
      pendingFlushFinal: Boolean(row.pendingFlushFinal),
      lastEventAt: row.lastEventAt ?? null,
      lastFlushedAt: row.lastFlushedAt ?? null,
      deletionRequested: Boolean(row.deletionRequested),
      recoveryRequired: Boolean(row.recoveryRequired),
    }
  }

  // -------------------------------------------------------------------
  // Grant states
  // -------------------------------------------------------------------

  readGrantStatesForActiveGrants(
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    return this.readGrantStatesForActiveGrantsIn(this.db, grants, timestamp)
  }

  readGrantStatesForBatch(
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    return this.readGrantStatesForBatchIn(this.db, grants, timestamps)
  }

  writeGrantConsumptions(states: Iterable<GrantConsumptionState>): number {
    return this.writeGrantConsumptionsIn(this.db, states)
  }

  private readGrantStatesForActiveGrantsIn(
    handle: SqliteHandle,
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    return this.readGrantStatesForBatchIn(handle, grants, [timestamp])
  }

  private readGrantStatesForBatchIn(
    handle: SqliteHandle,
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    const buckets = timestamps.flatMap((timestamp) =>
      grants
        .map((grant) => computeGrantPeriodBucket(grant, timestamp))
        .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
    )
    const bucketKeys = new Set(buckets.map((bucket) => bucket.bucketKey))
    const periodKeys = unique(buckets.map((bucket) => bucket.periodKey))

    if (bucketKeys.size === 0 || periodKeys.length === 0) {
      return []
    }

    return this.readGrantStatesForPeriodKeys(handle, periodKeys).filter((state) =>
      bucketKeys.has(state.bucketKey)
    )
  }

  private readGrantStatesForPeriodKeys(
    handle: SqliteHandle,
    periodKeys: string[]
  ): GrantConsumptionState[] {
    const states: GrantConsumptionState[] = []

    for (let i = 0; i < periodKeys.length; i += APPLY_BATCH_SIZE_LIMIT) {
      const rows = handle
        .select({
          grantStatesJson: entitlementPeriodUsageTable.grantStatesJson,
        })
        .from(entitlementPeriodUsageTable)
        .where(
          inArray(
            entitlementPeriodUsageTable.periodKey,
            periodKeys.slice(i, i + APPLY_BATCH_SIZE_LIMIT)
          )
        )
        .all()

      for (const row of rows) {
        states.push(
          ...parseCompactGrantStates(
            row.grantStatesJson,
            compactGrantConsumptionStateListSchema,
            this.logger
          )
        )
      }
    }

    return states
  }

  private writeGrantConsumptionsIn(
    handle: SqliteHandle,
    states: Iterable<GrantConsumptionState>
  ): number {
    const statesByPeriod = new Map<string, GrantConsumptionState[]>()
    for (const state of states) {
      const existing = statesByPeriod.get(state.periodKey)
      if (existing) {
        existing.push(state)
      } else {
        statesByPeriod.set(state.periodKey, [state])
      }
    }

    if (statesByPeriod.size === 0) {
      return 0
    }

    const updatedAt = Date.now()
    for (const [periodKey, periodStates] of statesByPeriod.entries()) {
      const existing = handle
        .select({
          grantStatesJson: entitlementPeriodUsageTable.grantStatesJson,
        })
        .from(entitlementPeriodUsageTable)
        .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
        .get()

      const mergedStates = existing
        ? parseCompactGrantStates(
            existing.grantStatesJson,
            compactGrantConsumptionStateListSchema,
            this.logger
          )
        : []
      for (const state of periodStates) {
        replaceGrantConsumptionState(mergedStates, state)
      }

      const sortedStates = mergedStates.sort((left, right) =>
        left.bucketKey.localeCompare(right.bucketKey)
      )
      const grantStatesJson = JSON.stringify(sortedStates)
      const periodStartAt = Math.min(...sortedStates.map((candidate) => candidate.periodStartAt))
      const periodEndAt = Math.max(...sortedStates.map((candidate) => candidate.periodEndAt))

      if (existing) {
        handle
          .update(entitlementPeriodUsageTable)
          .set({
            periodStartAt,
            periodEndAt,
            grantStatesJson,
            updatedAt,
          })
          .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
          .run()
      } else {
        handle
          .insert(entitlementPeriodUsageTable)
          .values({
            periodKey,
            periodStartAt,
            periodEndAt,
            grantStatesJson,
            updatedAt,
          })
          .run()
      }
    }

    this.onStateChanged()
    return statesByPeriod.size
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  readLifecycleEndAt(): number | null {
    const latestPeriodUsage = this.db
      .select({ periodEndAt: entitlementPeriodUsageTable.periodEndAt })
      .from(entitlementPeriodUsageTable)
      .orderBy(desc(entitlementPeriodUsageTable.periodEndAt))
      .limit(1)
      .get()

    const lifecycleEnds: number[] = []
    if (
      typeof latestPeriodUsage?.periodEndAt === "number" &&
      Number.isFinite(latestPeriodUsage.periodEndAt)
    ) {
      lifecycleEnds.push(latestPeriodUsage.periodEndAt)
    }
    const reservationEndAt = this.readWalletReservation()?.reservationEndAt
    if (typeof reservationEndAt === "number" && Number.isFinite(reservationEndAt)) {
      lifecycleEnds.push(reservationEndAt)
    }

    return lifecycleEnds.length > 0 ? Math.max(...lifecycleEnds) : null
  }

  // -------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------

  lookupCachedIdempotencyResult(eventId: string): ApplyResult | null {
    const batchEntry = this.getBatchIdempotencyResults().get(eventId)
    if (!batchEntry) return null

    return idempotencyEntryToApplyResult(batchEntry)
  }

  lookupCachedIdempotencyResults(eventIds: string[]): Map<string, BatchIdempotencyEntry> {
    const results = new Map<string, BatchIdempotencyEntry>()
    const uniqueEventIds = unique(eventIds)
    const batched = this.getBatchIdempotencyResults()

    for (const eventId of uniqueEventIds) {
      const entry = batched.get(eventId)
      if (entry) {
        results.set(eventId, entry)
      }
    }

    return results
  }

  private getBatchIdempotencyResults(): Map<string, BatchIdempotencyEntry> {
    if (!this.batchIdempotencyResults) {
      this.hydrateBatchIdempotencyResults()
    }

    return this.batchIdempotencyResults!
  }

  private hydrateBatchIdempotencyResults(): void {
    const results = new Map<string, BatchIdempotencyEntry>()
    const rows = this.db
      .select({
        entries: idempotencyKeyBatchesTable.entries,
      })
      .from(idempotencyKeyBatchesTable)
      .all()

    for (const row of rows) {
      let rawEntries: unknown
      try {
        rawEntries = JSON.parse(row.entries)
      } catch (error) {
        this.logger.warn("skipping unparsable idempotency batch row", {
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      const parsed = batchIdempotencyEntryListSchema.safeParse(rawEntries)
      if (!parsed.success) {
        this.logger.warn("skipping malformed idempotency batch row", {
          error: parsed.error.message,
        })
        continue
      }

      for (const entry of parsed.data) {
        results.set(entry.eventId, entry)
      }
    }

    this.batchIdempotencyResults = results
  }

  recordBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    if (entries.length === 0) {
      return
    }

    const results = this.getBatchIdempotencyResults()
    for (const entry of entries) {
      results.set(entry.eventId, entry)
    }
  }

  writeBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    this.writeBatchIdempotencyResultsIn(this.db, entries)
  }

  private writeBatchIdempotencyResultsIn(
    handle: SqliteHandle,
    entries: BatchIdempotencyEntry[]
  ): void {
    if (entries.length === 0) {
      return
    }

    handle
      .insert(idempotencyKeyBatchesTable)
      .values({
        createdAt: entries[0]?.createdAt ?? Date.now(),
        entries: JSON.stringify(entries),
      })
      .run()
  }

  cleanupStaleIdempotencyKeys(now: number): number {
    const staleIdempotencyCutoff = now - DO_IDEMPOTENCY_TTL_MS
    const staleBatchRows = this.db
      .select({ id: idempotencyKeyBatchesTable.id })
      .from(idempotencyKeyBatchesTable)
      .where(lt(idempotencyKeyBatchesTable.createdAt, staleIdempotencyCutoff))
      .orderBy(asc(idempotencyKeyBatchesTable.createdAt))
      .limit(IDEMPOTENCY_CLEANUP_BATCH_SIZE)
      .all()

    if (staleBatchRows.length > 0) {
      this.db
        .delete(idempotencyKeyBatchesTable)
        .where(
          inArray(
            idempotencyKeyBatchesTable.id,
            staleBatchRows.map((row) => row.id)
          )
        )
        .run()
      // Refresh a warm cache here, in the background alarm, so the next
      // customer request does not pay the full rehydrate. A cold cache stays
      // lazy — dormant windows woken only by alarms never scan the table.
      if (this.batchIdempotencyResults !== null) {
        this.hydrateBatchIdempotencyResults()
      }
    }

    return staleBatchRows.length
  }
}
