import type { ConfigFeatureVersionType, OverageStrategy, ResetConfig } from "@unprice/db/validators"
import type { GrantConsumptionState, MeterConfig } from "@unprice/services/entitlements"
import { DO_IDEMPOTENCY_TTL_MS, computeGrantPeriodBucket } from "@unprice/services/entitlements"
import { asc, desc, eq, inArray, lt } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import { idempotencyEntryToApplyResult } from "./batch-apply-helpers"
import { APPLY_BATCH_SIZE_LIMIT, IDEMPOTENCY_CLEANUP_BATCH_SIZE, WALLET_RESERVATION_ROW_ID } from "./constants"
import type {
  ActiveGrantInput,
  ApplyGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  EntitlementConfigInput,
  WalletReservationSnapshot,
} from "./contracts"
import { batchIdempotencyEntryListSchema, compactGrantConsumptionStateListSchema } from "./contracts"
import {
  entitlementConfigTable,
  entitlementPeriodUsageTable,
  grantsTable,
  idempotencyKeyBatchesTable,
  meterStateTable,
  schema,
  walletReservationTable,
} from "./db/schema"
import { extractCurrencyCodeFromFeatureConfig } from "./meter-helpers"
import type { MeterStateDraft } from "./meter-state-adapter"
import { jsonEquals, minNullableExpiry, unique } from "./utils"
import type { z } from "zod"

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

// ---------------------------------------------------------------------------
// Durable SQLite store
// ---------------------------------------------------------------------------

export class EntitlementWindowStore {
  private batchIdempotencyResults: Map<string, BatchIdempotencyEntry> | null = null

  constructor(
    private readonly db: DrizzleSqliteDODatabase<typeof schema>,
    private readonly logger: WarningLogger,
    private readonly onStateChanged: () => void
  ) {}

  // -------------------------------------------------------------------
  // Meter state
  // -------------------------------------------------------------------

  ensureMeterState(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      meterKey: string
      createdAt: number
    }
  ): void {
    tx.insert(meterStateTable)
      .values({
        meterKey: params.meterKey,
        usage: 0,
        updatedAt: null,
        createdAt: params.createdAt,
      })
      .onConflictDoNothing({ target: meterStateTable.meterKey })
      .run()
  }

  // -------------------------------------------------------------------
  // Wallet reservation
  // -------------------------------------------------------------------

  ensureWalletReservation(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      projectId: string
      customerId: string
      currency: string
      reservationEndAt: number
      billingPeriodId?: string | null
      cycleEndAt?: number | null
      cycleStartAt?: number | null
      featurePlanVersionItemId?: string | null
      featureSlug?: string | null
      statementKey?: string | null
    }
  ): void {
    tx.insert(walletReservationTable)
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

    tx.update(walletReservationTable)
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

  // -------------------------------------------------------------------
  // Entitlement config
  // -------------------------------------------------------------------

  syncEntitlementConfig(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      createdAt: number
      entitlement: EntitlementConfigInput
    }
  ): void {
    const existing = tx
      .select({
        customerEntitlementId: entitlementConfigTable.customerEntitlementId,
        projectId: entitlementConfigTable.projectId,
        customerId: entitlementConfigTable.customerId,
        effectiveAt: entitlementConfigTable.effectiveAt,
        expiresAt: entitlementConfigTable.expiresAt,
        featureConfig: entitlementConfigTable.featureConfig,
        featurePlanVersionId: entitlementConfigTable.featurePlanVersionId,
        featureSlug: entitlementConfigTable.featureSlug,
        meterConfig: entitlementConfigTable.meterConfig,
        overageStrategy: entitlementConfigTable.overageStrategy,
        resetConfig: entitlementConfigTable.resetConfig,
      })
      .from(entitlementConfigTable)
      .where(
        eq(entitlementConfigTable.customerEntitlementId, params.entitlement.customerEntitlementId)
      )
      .get()

    const values = {
      customerEntitlementId: params.entitlement.customerEntitlementId,
      projectId: params.entitlement.projectId,
      customerId: params.entitlement.customerId,
      effectiveAt: params.entitlement.effectiveAt,
      expiresAt: params.entitlement.expiresAt,
      featureConfig: params.entitlement.featureConfig,
      featurePlanVersionId: params.entitlement.featurePlanVersionId,
      featureSlug: params.entitlement.featureSlug,
      meterConfig: params.entitlement.meterConfig,
      overageStrategy: params.entitlement.overageStrategy,
      resetConfig: params.entitlement.resetConfig ?? null,
      updatedAt: params.createdAt,
    }

    if (existing) {
      this.assertImmutableEntitlementConfig(existing, params.entitlement)

      const nextExpiresAt = minNullableExpiry(existing.expiresAt ?? null, values.expiresAt)
      if (nextExpiresAt !== (existing.expiresAt ?? null)) {
        tx.update(entitlementConfigTable)
          .set({
            expiresAt: nextExpiresAt,
            updatedAt: params.createdAt,
          })
          .where(
            eq(
              entitlementConfigTable.customerEntitlementId,
              params.entitlement.customerEntitlementId
            )
          )
          .run()
        this.onStateChanged()
      }
      return
    }

    tx.insert(entitlementConfigTable)
      .values({
        ...values,
        addedAt: params.createdAt,
      })
      .run()
    this.onStateChanged()
  }

  assertImmutableEntitlementConfig(
    existing: {
      customerEntitlementId: string
      projectId: string
      customerId: string
      effectiveAt: number
      featureConfig: ConfigFeatureVersionType
      featurePlanVersionId: string
      featureSlug: string
      meterConfig: MeterConfig
      overageStrategy: OverageStrategy
      resetConfig: ResetConfig | null
    },
    incoming: EntitlementConfigInput
  ): void {
    const mismatches: string[] = []

    if (existing.customerEntitlementId !== incoming.customerEntitlementId) {
      mismatches.push("customerEntitlementId")
    }
    if (existing.projectId !== incoming.projectId) mismatches.push("projectId")
    if (existing.customerId !== incoming.customerId) mismatches.push("customerId")
    if (existing.effectiveAt !== incoming.effectiveAt) mismatches.push("effectiveAt")
    if (existing.featurePlanVersionId !== incoming.featurePlanVersionId) {
      mismatches.push("featurePlanVersionId")
    }
    if (existing.featureSlug !== incoming.featureSlug) mismatches.push("featureSlug")
    if (existing.overageStrategy !== incoming.overageStrategy) mismatches.push("overageStrategy")
    if (!jsonEquals(existing.featureConfig, incoming.featureConfig)) {
      mismatches.push("featureConfig")
    }
    if (!jsonEquals(existing.meterConfig, incoming.meterConfig)) {
      mismatches.push("meterConfig")
    }
    if (!jsonEquals(existing.resetConfig ?? null, incoming.resetConfig ?? null)) {
      mismatches.push("resetConfig")
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Immutable entitlement config changed for ${incoming.customerEntitlementId}: ${mismatches.join(", ")}`
      )
    }
  }

  readEntitlementConfig(
    tx: DrizzleSqliteDODatabase<typeof schema>
  ): EntitlementConfigInput | null {
    const row = tx
      .select({
        customerEntitlementId: entitlementConfigTable.customerEntitlementId,
        projectId: entitlementConfigTable.projectId,
        customerId: entitlementConfigTable.customerId,
        effectiveAt: entitlementConfigTable.effectiveAt,
        expiresAt: entitlementConfigTable.expiresAt,
        featureConfig: entitlementConfigTable.featureConfig,
        featurePlanVersionId: entitlementConfigTable.featurePlanVersionId,
        featureSlug: entitlementConfigTable.featureSlug,
        meterConfig: entitlementConfigTable.meterConfig,
        overageStrategy: entitlementConfigTable.overageStrategy,
        resetConfig: entitlementConfigTable.resetConfig,
      })
      .from(entitlementConfigTable)
      .get()

    if (!row) {
      return null
    }

    return {
      billingPeriods: [],
      creditLinePolicy: "uncapped",
      customerEntitlementId: row.customerEntitlementId,
      projectId: row.projectId,
      customerId: row.customerId,
      effectiveAt: row.effectiveAt,
      expiresAt: row.expiresAt ?? null,
      featureConfig: row.featureConfig,
      featurePlanVersionId: row.featurePlanVersionId,
      featureSlug: row.featureSlug,
      featureType: "usage",
      meterConfig: row.meterConfig,
      overageStrategy: row.overageStrategy,
      resetConfig: row.resetConfig ?? null,
      subscriptionItemId: null,
    }
  }

  // -------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------

  syncGrants(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      customerEntitlementId: string
      createdAt: number
      grants: ApplyGrantInput[]
    }
  ): void {
    for (const grant of params.grants) {
      const existing = tx
        .select({
          grantId: grantsTable.grantId,
          expiresAt: grantsTable.expiresAt,
        })
        .from(grantsTable)
        .where(eq(grantsTable.grantId, grant.grantId))
        .get()

      if (existing) {
        const nextExpiresAt = minNullableExpiry(existing.expiresAt ?? null, grant.expiresAt)
        if (nextExpiresAt !== (existing.expiresAt ?? null)) {
          tx.update(grantsTable)
            .set({ expiresAt: nextExpiresAt })
            .where(eq(grantsTable.grantId, grant.grantId))
            .run()
          this.onStateChanged()
        }
      } else {
        tx.insert(grantsTable)
          .values({
            grantId: grant.grantId,
            customerEntitlementId: params.customerEntitlementId,
            allowanceUnits: grant.allowanceUnits,
            effectiveAt: grant.effectiveAt,
            expiresAt: grant.expiresAt,
            priority: grant.priority,
            addedAt: params.createdAt,
          })
          .run()
        this.onStateChanged()
      }
    }
  }

  readGrants(tx: DrizzleSqliteDODatabase<typeof schema>): ActiveGrantInput[] {
    const entitlement = this.readEntitlementConfig(tx)
    if (!entitlement) {
      return []
    }

    return tx
      .select({
        grantId: grantsTable.grantId,
        allowanceUnits: grantsTable.allowanceUnits,
        effectiveAt: grantsTable.effectiveAt,
        expiresAt: grantsTable.expiresAt,
        priority: grantsTable.priority,
      })
      .from(grantsTable)
      .all()
      .map((row) => ({
        allowanceUnits: row.allowanceUnits ?? null,
        cadenceEffectiveAt: entitlement.effectiveAt,
        cadenceExpiresAt: entitlement.expiresAt,
        currencyCode: extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt ?? null,
        grantId: row.grantId,
        priority: row.priority,
        resetConfig: entitlement.resetConfig ?? null,
      }))
  }

  // -------------------------------------------------------------------
  // Grant states
  // -------------------------------------------------------------------

  readGrantStatesForActiveGrants(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    const buckets = grants
      .map((grant) => computeGrantPeriodBucket(grant, timestamp))
      .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
    const bucketKeys = new Set(buckets.map((bucket) => bucket.bucketKey))
    const periodKeys = unique(buckets.map((bucket) => bucket.periodKey))

    if (bucketKeys.size === 0 || periodKeys.length === 0) {
      return []
    }

    return this.readGrantStatesForPeriodKeys(tx, periodKeys).filter((state) =>
      bucketKeys.has(state.bucketKey)
    )
  }

  readGrantStatesForBatch(
    tx: DrizzleSqliteDODatabase<typeof schema>,
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

    return this.readGrantStatesForPeriodKeys(tx, periodKeys).filter((state) =>
      bucketKeys.has(state.bucketKey)
    )
  }

  readGrantStatesForPeriodKeys(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    periodKeys: string[]
  ): GrantConsumptionState[] {
    const states: GrantConsumptionState[] = []

    for (let i = 0; i < periodKeys.length; i += APPLY_BATCH_SIZE_LIMIT) {
      const rows = tx
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
          ...parseCompactGrantStates(row.grantStatesJson, compactGrantConsumptionStateListSchema, this.logger)
        )
      }
    }

    return states
  }

  selectGrantStatesForActiveGrants(
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

  // -------------------------------------------------------------------
  // Meter state draft
  // -------------------------------------------------------------------

  readMeterStateDraft(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    meterKey: string,
    createdAt: number
  ): MeterStateDraft {
    const row = tx
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

  // -------------------------------------------------------------------
  // Grant consumptions
  // -------------------------------------------------------------------

  writeGrantConsumptions(
    tx: DrizzleSqliteDODatabase<typeof schema>,
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
      const existing = tx
        .select({
          grantStatesJson: entitlementPeriodUsageTable.grantStatesJson,
        })
        .from(entitlementPeriodUsageTable)
        .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
        .get()

      const mergedStates = existing
        ? parseCompactGrantStates(existing.grantStatesJson, compactGrantConsumptionStateListSchema, this.logger)
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
        tx.update(entitlementPeriodUsageTable)
          .set({
            periodStartAt,
            periodEndAt,
            grantStatesJson,
            updatedAt,
          })
          .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
          .run()
      } else {
        tx.insert(entitlementPeriodUsageTable)
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
    const reservationEndAt = this.readWalletReservation(this.db)?.reservationEndAt
    if (typeof reservationEndAt === "number" && Number.isFinite(reservationEndAt)) {
      lifecycleEnds.push(reservationEndAt)
    }

    return lifecycleEnds.length > 0 ? Math.max(...lifecycleEnds) : null
  }

  readWalletReservation(
    tx: DrizzleSqliteDODatabase<typeof schema>
  ): WalletReservationSnapshot {
    const row = tx
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

  hydrateBatchIdempotencyResults(): void {
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

  writeBatchIdempotencyResults(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    entries: BatchIdempotencyEntry[]
  ): void {
    if (entries.length === 0) {
      return
    }

    tx.insert(idempotencyKeyBatchesTable)
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
      this.batchIdempotencyResults = null
    }

    return staleBatchRows.length
  }
}
