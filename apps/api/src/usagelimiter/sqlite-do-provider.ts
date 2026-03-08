import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import {
  LAKEHOUSE_INTERNAL_METADATA_KEYS,
  type LakehouseCursorState,
  type LakehouseEntitlementSnapshotEvent,
  type LakehouseJsonValue,
  type LakehouseMetadataEvent,
  type LakehouseService,
  type LakehouseUsageEvent,
  type LakehouseVerificationEvent,
  getLakehouseSourceCurrentVersion,
} from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import {
  type UnPriceEntitlementStorage,
  UnPriceEntitlementStorageError,
} from "@unprice/services/entitlements"
import { inArray, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import xxhash, { type XXHashAPI } from "xxhash-wasm"
import { type UsageRecord, type Verification, schema } from "~/db/types"
import { SqliteDurableObjectKernel } from "~/durable-object/sqlite-kernel"
import { toEventDate } from "~/lakehouse/pipeline"
import migrations from "../../drizzle/migrations"

// Constants
const BATCH_SIZE = 1000
const METADATA_RETENTION_DAYS = 3
const WINDOW_5_MIN = 300
const WINDOW_60_MIN = 3600
const WINDOW_1_DAY = 86400
const WINDOW_7_DAYS = 604800
const MINUTE_BUCKET_SECONDS = 60
const FIVE_MIN_BUCKET_SECONDS = WINDOW_5_MIN
const HOUR_BUCKET_SECONDS = 3600
const DAY_BUCKET_SECONDS = WINDOW_1_DAY
const AGGREGATE_BUCKETS = [
  MINUTE_BUCKET_SECONDS,
  FIVE_MIN_BUCKET_SECONDS,
  HOUR_BUCKET_SECONDS,
  DAY_BUCKET_SECONDS,
] as const
const MINUTE_AGGREGATE_RETENTION_SECONDS = WINDOW_5_MIN
const FIVE_MIN_AGGREGATE_RETENTION_SECONDS = WINDOW_60_MIN
const HOUR_AGGREGATE_RETENTION_SECONDS = WINDOW_1_DAY
const DAY_AGGREGATE_RETENTION_SECONDS = WINDOW_7_DAYS
const STATE_KEY_PREFIX = "state:"
const STATE_COLLECTION_ENTITLEMENT = "entitlement"
const STATE_COLLECTION_CURSOR = "cursor"
const CURSOR_STATE_KEY = "cursor_state"
const DEDUPE_SCOPE_METADATA = "metadata"
const DEDUPE_SCOPE_SNAPSHOT = "snapshot"
const DELIVERY_STREAM_USAGE = "usage"
const DELIVERY_STREAM_VERIFICATION = "verification"
const USAGE_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("usage")
const VERIFICATION_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("verification")
const METADATA_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("metadata")
const ENTITLEMENT_SNAPSHOT_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("entitlement_snapshot")
const INTERNAL_METADATA_KEYS = new Set<string>(LAKEHOUSE_INTERNAL_METADATA_KEYS)
const EMPTY_LAKEHOUSE_CURSOR_STATE: LakehouseCursorState = {
  lastR2UsageId: null,
  lastR2VerificationId: null,
}

// Type guard for EntitlementState
function isEntitlementState(value: unknown): value is EntitlementState {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.customerId === "string" &&
    typeof obj.projectId === "string" &&
    typeof obj.featureSlug === "string"
  )
}

function isCursorState(value: unknown): value is CursorState {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  const isNullableNumber = (entry: unknown): boolean => entry === null || typeof entry === "number"

  return (
    isNullableNumber(obj.lastTinybirdUsageSeq) &&
    isNullableNumber(obj.lastR2UsageSeq) &&
    isNullableNumber(obj.lastTinybirdVerificationSeq) &&
    isNullableNumber(obj.lastR2VerificationSeq)
  )
}

function normalizeJsonValue(value: unknown): LakehouseJsonValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry))
  }

  if (typeof value === "object") {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalizeJsonValue(entry)] as const)

    return Object.fromEntries(normalizedEntries)
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function toStableMetadataJson(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "{}"
  }

  const sortedKeys = Object.keys(metadata).sort()
  const normalized: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    normalized[key] = metadata[key]
  }

  return JSON.stringify(normalized)
}

// Batch result type for type safety
interface BatchResult<T> {
  records: T[]
  firstSeq: number | null
  lastSeq: number | null
}

// Processed record with metadata for internal use
interface CursorState {
  lastTinybirdUsageSeq: number | null
  lastR2UsageSeq: number | null
  lastTinybirdVerificationSeq: number | null
  lastR2VerificationSeq: number | null
}

interface LakehousePreparedPayload {
  cursorState: LakehouseCursorState
  usageRecords: LakehouseUsageEvent[]
  verificationRecords: LakehouseVerificationEvent[]
  metadataRecords: LakehouseMetadataEvent[]
}

interface FlushSummary {
  usage: { count: number; lastId: string | null }
  verification: { count: number; lastId: string | null }
}

interface EntitlementSnapshotBuildResult {
  snapshots: LakehouseEntitlementSnapshotEvent[]
  emittedSnapshotIds: Set<string>
}

export interface FlushPressureStats {
  pendingUsageRecords: number
  pendingVerificationRecords: number
  pendingTotalRecords: number
  oldestPendingTimestamp: number | null
  oldestPendingAgeSeconds: number
}

/**
 * SQLite Storage Provider for Durable Objects
 *
 * Key design principles:
 * 1. All state mutations happen inside blockConcurrencyWhile to prevent race conditions
 * 2. Fail-fast with Result type - no throwing except for unrecoverable errors
 * 3. Single responsibility methods with clear boundaries
 * 4. Type-safe transformations between storage and analytics types
 */
export class SqliteDOStorageProvider implements UnPriceEntitlementStorage {
  readonly name = "sqlite-do"

  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly storage: DurableObjectStorage
  private readonly state: DurableObjectState
  private readonly doKernel: SqliteDurableObjectKernel
  private readonly analytics: Analytics
  private readonly logger: Logger
  private readonly lakehouseService: LakehouseService

  // Memoized entitlement states for fast lookups
  private stateCache = new Map<string, EntitlementState>()
  private initialized = false
  private cursors: CursorState = {
    lastTinybirdUsageSeq: null,
    lastR2UsageSeq: null,
    lastTinybirdVerificationSeq: null,
    lastR2VerificationSeq: null,
  }

  // Lazily initialized xxhash instance (WASM module)
  private xxhashInstance: XXHashAPI | null = null
  private inFlightFlush: Promise<Result<FlushSummary, UnPriceEntitlementStorageError>> | null = null

  constructor(args: {
    storage: DurableObjectStorage
    state: DurableObjectState
    analytics: Analytics
    logger: Logger
    lakehouseService: LakehouseService
  }) {
    this.storage = args.storage
    this.state = args.state
    this.analytics = args.analytics
    this.logger = args.logger
    this.lakehouseService = args.lakehouseService
    this.db = drizzle(args.storage, { schema, logger: false })
    this.doKernel = new SqliteDurableObjectKernel(this.db)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.db, migrations)
        await this.loadStateCache()
        await this.loadCursors()
        this.initialized = true
        return Ok(undefined)
      } catch (error) {
        this.initialized = false
        this.stateCache.clear()
        return this.logAndError("initialize", error)
      }
    })
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new UnPriceEntitlementStorageError({ message: "Storage provider not initialized" })
    }
  }

  private async loadStateCache(): Promise<void> {
    const entries = await this.doKernel.listObjects(STATE_COLLECTION_ENTITLEMENT)

    this.stateCache.clear()

    for (const entry of entries) {
      try {
        const value = JSON.parse(entry.payload) as unknown
        if (isEntitlementState(value)) {
          this.stateCache.set(entry.key, value)
        }
      } catch {
        this.logger.warn("Failed to parse entitlement state payload", { key: entry.key })
      }
    }
  }

  private async loadCursors(): Promise<void> {
    const payload = await this.doKernel.getObject(STATE_COLLECTION_CURSOR, CURSOR_STATE_KEY)
    if (!payload) {
      return
    }

    try {
      const value = JSON.parse(payload) as unknown
      if (isCursorState(value)) {
        this.cursors = value
      }
    } catch {
      this.logger.warn("Failed to parse cursor state payload")
    }
  }

  private async saveCursors(): Promise<void> {
    await this.doKernel.putObject({
      collection: STATE_COLLECTION_CURSOR,
      key: CURSOR_STATE_KEY,
      payload: JSON.stringify(this.cursors),
    })
  }

  private resetInMemoryCursors(): void {
    this.cursors = {
      lastTinybirdUsageSeq: null,
      lastR2UsageSeq: null,
      lastTinybirdVerificationSeq: null,
      lastR2VerificationSeq: null,
    }
  }

  private buildMetadataPayload(metadata: unknown): string {
    if (!isRecord(metadata)) {
      return "{}"
    }

    const tagEntries = Object.entries(metadata).filter(
      ([key, value]) => !INTERNAL_METADATA_KEYS.has(key) && value !== undefined
    )

    if (tagEntries.length === 0) {
      return "{}"
    }

    return toStableMetadataJson(Object.fromEntries(tagEntries))
  }

  private async ensureMetadataRecord(params: {
    metadata: unknown
    projectId: string
    customerId: string
    timestamp: number
  }): Promise<string> {
    const payload = this.buildMetadataPayload(params.metadata)
    if (payload === "{}") {
      return "0"
    }

    const metaId = await this.computeMetadataIdentity({
      payload,
      projectId: params.projectId,
      customerId: params.customerId,
    })

    await this.db
      .insert(schema.metadataRecords)
      .values({
        id: metaId,
        payload,
        project_id: params.projectId,
        customer_id: params.customerId,
        timestamp: params.timestamp,
        created_at: Date.now(),
      })
      .onConflictDoNothing()

    return metaId
  }

  private async computeMetadataIdentity(params: {
    payload: string
    projectId: string
    customerId: string
  }): Promise<string> {
    const hasher = await this.getXxhash()
    return hasher
      .h64(`${params.projectId}\u0000${params.customerId}\u0000${params.payload}`)
      .toString()
  }

  private async nextDeliverySeq(
    stream: typeof DELIVERY_STREAM_USAGE | typeof DELIVERY_STREAM_VERIFICATION
  ): Promise<number> {
    const now = Date.now()
    const result = await this.db
      .insert(schema.deliverySequences)
      .values({
        stream,
        current_seq: 1,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: schema.deliverySequences.stream,
        set: {
          current_seq: sql`${schema.deliverySequences.current_seq} + 1`,
          updated_at: now,
        },
      })
      .returning({ seq: schema.deliverySequences.current_seq })

    const seq = result[0]?.seq
    if (!seq || !Number.isInteger(seq) || seq <= 0) {
      throw new Error(`Failed to allocate delivery sequence for stream ${stream}`)
    }

    return seq
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────────

  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey(params)

      // Check cache first
      const cached = this.stateCache.get(key)
      if (cached) return Ok(cached)

      const payload = await this.doKernel.getObject(STATE_COLLECTION_ENTITLEMENT, key)
      if (!payload) {
        return Ok(null)
      }

      try {
        const value = JSON.parse(payload) as unknown
        if (isEntitlementState(value)) {
          this.stateCache.set(key, value)
          return Ok(value)
        }
      } catch {
        this.logger.warn("Failed to parse entitlement state payload", { key })
      }

      return Ok(null)
    } catch (error) {
      return this.logAndError("get", error)
    }
  }

  async getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const entries = await this.doKernel.listObjects(STATE_COLLECTION_ENTITLEMENT)
      const nextCache = new Map<string, EntitlementState>()

      for (const entry of entries) {
        try {
          const value = JSON.parse(entry.payload) as unknown
          if (isEntitlementState(value)) {
            nextCache.set(entry.key, value)
          }
        } catch {
          this.logger.warn("Failed to parse entitlement state payload", { key: entry.key })
        }
      }

      this.stateCache = nextCache
      return Ok(Array.from(nextCache.values()))
    } catch (error) {
      return this.logAndError("getAll", error)
    }
  }

  async set(params: {
    state: EntitlementState
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })

      await this.doKernel.putObject({
        collection: STATE_COLLECTION_ENTITLEMENT,
        key,
        payload: JSON.stringify(params.state),
      })
      this.stateCache.set(key, params.state)

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("set", error)
    }
  }

  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const key = this.makeKey(params)

      await this.doKernel.deleteObject(STATE_COLLECTION_ENTITLEMENT, key)
      this.stateCache.delete(key)

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("delete", error)
    }
  }

  async deleteAll(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        this.assertInitialized()
        await this.storage.deleteAll()
        this.stateCache.clear()
        this.resetInMemoryCursors()
        await migrate(this.db, migrations)
        return Ok(undefined)
      } catch (error) {
        return this.logAndError("deleteAll", error)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Usage & Verification Recording
  // ─────────────────────────────────────────────────────────────────────────────

  async hasIdempotenceKey(
    idempotenceKey: string
  ): Promise<Result<boolean, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const result = await this.db
        .select({ id: schema.usageRecords.id })
        .from(schema.usageRecords)
        .where(sql`${schema.usageRecords.idempotence_key} = ${idempotenceKey}`)
        .limit(1)

      return Ok(result.length > 0)
    } catch (error) {
      return this.logAndError("hasIdempotenceKey", error)
    }
  }

  async insertUsageRecord(
    record: AnalyticsUsage
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const seq = await this.nextDeliverySeq(DELIVERY_STREAM_USAGE)
      const metaId = await this.ensureMetadataRecord({
        metadata: record.metadata ?? null,
        projectId: record.project_id,
        customerId: record.customer_id,
        timestamp: record.timestamp,
      })

      const inserted = await this.db
        .insert(schema.usageRecords)
        .values({
          id: record.id,
          seq,
          customer_id: record.customer_id,
          feature_slug: record.feature_slug,
          usage: String(record.usage),
          timestamp: record.timestamp,
          created_at: record.created_at,
          metadata: record.metadata ? JSON.stringify(record.metadata) : null,
          cost: record.cost != null ? String(record.cost) : null,
          rate_amount: record.rate_amount != null ? String(record.rate_amount) : null,
          rate_currency: record.rate_currency ?? null,
          entitlement_id: record.entitlement_id,
          meta_id: metaId,
          deleted: record.deleted ?? 0,
          idempotence_key: record.idempotence_key,
          request_id: record.request_id,
          project_id: record.project_id,
          // first-class analytics columns
          country: record.country ?? "UNK",
          region: record.region ?? "UNK",
          action: record.action ?? null,
          key_id: record.key_id ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.usageRecords.id })

      if (inserted.length === 0) {
        return Ok(undefined)
      }

      await this.updateUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        usage: Number(record.usage ?? 0),
      })

      await this.updateReportUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        reportUsage: 1,
        limitExceeded: 0,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertUsageRecord", error)
    }
  }

  async insertVerification(
    record: AnalyticsVerification
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()
      const seq = await this.nextDeliverySeq(DELIVERY_STREAM_VERIFICATION)
      const metaId = await this.ensureMetadataRecord({
        metadata: record.metadata ?? null,
        projectId: record.project_id,
        customerId: record.customer_id,
        timestamp: record.timestamp,
      })

      await this.db.insert(schema.verifications).values({
        seq,
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        project_id: record.project_id,
        timestamp: record.timestamp,
        created_at: record.created_at,
        request_id: record.request_id,
        denied_reason: record.denied_reason ?? null,
        latency: record.latency != null ? String(record.latency) : "0",
        allowed: record.allowed,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        meta_id: metaId,
        usage: record.usage != null ? String(record.usage) : null,
        remaining: record.remaining != null ? String(record.remaining) : null,
        entitlement_id: record.entitlement_id,
        // first-class analytics columns
        country: record.country ?? "UNK",
        region: record.region ?? "UNK",
        action: record.action ?? null,
        key_id: record.key_id ?? null,
      })

      await this.updateVerificationAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        allowed: record.allowed,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertVerification", error)
    }
  }

  async insertReportUsageDeniedEvent(record: {
    project_id: string
    customer_id: string
    feature_slug: string
    timestamp: number
    denied_reason: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      if (record.denied_reason !== "LIMIT_EXCEEDED") {
        return Ok(undefined)
      }

      await this.updateReportUsageAggregates({
        timestamp: record.timestamp,
        featureSlug: record.feature_slug,
        reportUsage: 1,
        limitExceeded: 1,
      })

      return Ok(undefined)
    } catch (error) {
      return this.logAndError("insertReportUsageDeniedEvent", error)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Flush & Reset
  // ─────────────────────────────────────────────────────────────────────────────

  async flush(): Promise<Result<FlushSummary, UnPriceEntitlementStorageError>> {
    if (this.inFlightFlush) {
      this.logger.debug("Flush already in progress, waiting for existing run")
      return this.inFlightFlush
    }

    const flushPromise = this.flushInternal().finally(() => {
      this.inFlightFlush = null
    })

    this.inFlightFlush = flushPromise
    return flushPromise
  }

  private async flushInternal(): Promise<Result<FlushSummary, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const [usageBatch, verificationBatch] = await Promise.all([
        this.fetchUsageBatch(),
        this.fetchVerificationBatch(),
      ])

      const usageForTinybird = this.filterUsageRecordsAfterCursor(
        usageBatch.records,
        this.cursors.lastTinybirdUsageSeq
      )
      const verificationForTinybird = this.filterVerificationRecordsAfterCursor(
        verificationBatch.records,
        this.cursors.lastTinybirdVerificationSeq
      )
      const usageForR2 = this.filterUsageRecordsAfterCursor(
        usageBatch.records,
        this.cursors.lastR2UsageSeq
      )
      const verificationForR2 = this.filterVerificationRecordsAfterCursor(
        verificationBatch.records,
        this.cursors.lastR2VerificationSeq
      )

      const eventDateKey = this.getTodayKey()
      const seenMetaSet = await this.getSeenMetaSet(eventDateKey)
      const metadataRefs = this.collectUnseenMetadataRefs({
        usageRecords: usageForR2,
        verificationRecords: verificationForR2,
        seenMetaSet,
      })

      const metadataRows = await this.fetchMetadataRowsByRefs(metadataRefs)
      if (metadataRows.length < metadataRefs.length) {
        this.logger.warn("Missing metadata rows for referenced metadata keys", {
          requested_count: metadataRefs.length,
          found_count: metadataRows.length,
          missing_count: metadataRefs.length - metadataRows.length,
        })
      }

      const metadataRecords = this.buildLakehouseMetadataRecords(metadataRows)
      const metadataSeenKeys = this.toMetadataSeenKeys(metadataRows)

      const seenSnapshotSet = await this.getSeenSnapshotSet(eventDateKey)
      const lakehousePrepared: LakehousePreparedPayload = {
        cursorState: EMPTY_LAKEHOUSE_CURSOR_STATE,
        usageRecords: this.buildLakehouseUsageRecords(usageForR2),
        verificationRecords: this.buildLakehouseVerificationRecords(verificationForR2),
        metadataRecords,
      }

      const snapshotBuild = await this.buildEntitlementSnapshots({
        prepared: lakehousePrepared,
        seenSnapshotSet,
      })

      const [r2Result, usageResult, verificationResult] = await Promise.all([
        this.flushToR2(lakehousePrepared, snapshotBuild.snapshots),
        this.ingestUsageToTinybird(usageForTinybird),
        this.ingestVerificationsToTinybird(verificationForTinybird),
      ])

      const failedSinks: string[] = []
      let cursorsChanged = false

      if (usageForTinybird.length > 0) {
        if (usageResult.success) {
          const nextTinybirdUsageSeq = this.getLatestUsageSeq(usageForTinybird)
          if (
            nextTinybirdUsageSeq !== null &&
            this.cursors.lastTinybirdUsageSeq !== nextTinybirdUsageSeq
          ) {
            this.cursors.lastTinybirdUsageSeq = nextTinybirdUsageSeq
            cursorsChanged = true
          }
        } else {
          failedSinks.push("tinybird_usage")
        }
      }

      if (verificationForTinybird.length > 0) {
        if (verificationResult.success) {
          const nextTinybirdVerificationSeq = this.getLatestVerificationSeq(verificationForTinybird)
          if (
            nextTinybirdVerificationSeq !== null &&
            this.cursors.lastTinybirdVerificationSeq !== nextTinybirdVerificationSeq
          ) {
            this.cursors.lastTinybirdVerificationSeq = nextTinybirdVerificationSeq
            cursorsChanged = true
          }
        } else {
          failedSinks.push("tinybird_verification")
        }
      }

      const hasLakehousePayload =
        lakehousePrepared.usageRecords.length > 0 ||
        lakehousePrepared.verificationRecords.length > 0 ||
        lakehousePrepared.metadataRecords.length > 0 ||
        snapshotBuild.snapshots.length > 0

      if (hasLakehousePayload) {
        if (r2Result.success) {
          const nextR2UsageSeq = this.getLatestUsageSeq(usageForR2)
          if (nextR2UsageSeq !== null && this.cursors.lastR2UsageSeq !== nextR2UsageSeq) {
            this.cursors.lastR2UsageSeq = nextR2UsageSeq
            cursorsChanged = true
          }

          const nextR2VerificationSeq = this.getLatestVerificationSeq(verificationForR2)
          if (
            nextR2VerificationSeq !== null &&
            this.cursors.lastR2VerificationSeq !== nextR2VerificationSeq
          ) {
            this.cursors.lastR2VerificationSeq = nextR2VerificationSeq
            cursorsChanged = true
          }

          if (metadataSeenKeys.size > 0) {
            await this.updateSeenMetaSet(eventDateKey, metadataSeenKeys)
          }

          if (snapshotBuild.emittedSnapshotIds.size > 0) {
            await this.updateSeenSnapshotSet(eventDateKey, snapshotBuild.emittedSnapshotIds)
          }
        } else {
          failedSinks.push("lakehouse_r2")
        }
      }

      if (cursorsChanged) {
        await this.saveCursors()
      }

      if (this.isUsageBatchSafeToDelete(usageBatch)) {
        await this.deleteUsageRecordsBatch(usageBatch.firstSeq!, usageBatch.lastSeq!)
      }

      if (this.isVerificationBatchSafeToDelete(verificationBatch)) {
        await this.deleteVerificationRecordsBatch(
          verificationBatch.firstSeq!,
          verificationBatch.lastSeq!
        )
      }

      await this.pruneAggregateBuckets(Date.now())

      const summary: FlushSummary = {
        usage: {
          count: usageBatch.records.length,
          lastId:
            usageBatch.records.length > 0
              ? usageBatch.records[usageBatch.records.length - 1]!.id
              : null,
        },
        verification: {
          count: verificationBatch.records.length,
          lastId:
            verificationBatch.records.length > 0
              ? verificationBatch.records[verificationBatch.records.length - 1]!.id.toString()
              : null,
        },
      }

      if (failedSinks.length > 0) {
        return Err(
          new UnPriceEntitlementStorageError({
            message: `flush incomplete: ${failedSinks.join(", ")}`,
          })
        )
      }

      return Ok(summary)
    } catch (error) {
      return this.logAndError("flush", error)
    }
  }

  private filterUsageRecordsAfterCursor(
    records: UsageRecord[],
    cursor: number | null
  ): UsageRecord[] {
    if (cursor === null) {
      return records
    }
    return records.filter((record) => record.seq > cursor)
  }

  private filterVerificationRecordsAfterCursor(
    records: Verification[],
    cursor: number | null
  ): Verification[] {
    if (cursor === null) {
      return records
    }
    return records.filter((record) => record.seq > cursor)
  }

  private getLatestUsageSeq(records: UsageRecord[]): number | null {
    if (records.length === 0) {
      return null
    }
    return records[records.length - 1]!.seq
  }

  private getLatestVerificationSeq(records: Verification[]): number | null {
    if (records.length === 0) {
      return null
    }
    return records[records.length - 1]!.seq
  }

  private collectUnseenMetadataRefs(params: {
    usageRecords: UsageRecord[]
    verificationRecords: Verification[]
    seenMetaSet: Set<string>
  }): string[] {
    const requestedMetadataIds = new Set<string>()

    for (const record of params.usageRecords) {
      const metaId = String(record.meta_id ?? "0")
      if (metaId === "0") {
        continue
      }

      if (!params.seenMetaSet.has(metaId)) {
        requestedMetadataIds.add(metaId)
      }
    }

    for (const record of params.verificationRecords) {
      const metaId = String(record.meta_id ?? "0")
      if (metaId === "0") {
        continue
      }

      if (!params.seenMetaSet.has(metaId)) {
        requestedMetadataIds.add(metaId)
      }
    }

    return Array.from(requestedMetadataIds)
  }

  private toMetadataSeenKeys(
    rows: Array<{ id: string; project_id: string; customer_id: string }>
  ): Set<string> {
    return new Set(rows.map((row) => row.id))
  }

  private isUsageBatchSafeToDelete(batch: BatchResult<UsageRecord>): boolean {
    if (batch.firstSeq === null || batch.lastSeq === null) {
      return false
    }

    // A record is deletable only after both sinks acknowledged past the batch tail.
    const tinybirdSafe =
      this.cursors.lastTinybirdUsageSeq !== null &&
      this.cursors.lastTinybirdUsageSeq >= batch.lastSeq
    const r2Safe =
      this.cursors.lastR2UsageSeq !== null && this.cursors.lastR2UsageSeq >= batch.lastSeq

    return tinybirdSafe && r2Safe
  }

  private isVerificationBatchSafeToDelete(batch: BatchResult<Verification>): boolean {
    if (batch.firstSeq === null || batch.lastSeq === null) {
      return false
    }

    // A record is deletable only after both sinks acknowledged past the batch tail.
    const tinybirdSafe =
      this.cursors.lastTinybirdVerificationSeq !== null &&
      this.cursors.lastTinybirdVerificationSeq >= batch.lastSeq
    const r2Safe =
      this.cursors.lastR2VerificationSeq !== null &&
      this.cursors.lastR2VerificationSeq >= batch.lastSeq

    return tinybirdSafe && r2Safe
  }

  async reset(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    // Wrap entire reset in blockConcurrencyWhile to prevent race conditions
    return this.state.blockConcurrencyWhile(async () => {
      try {
        // 1. Try to flush pending data
        const flushResult = await this.flush()
        if (flushResult.err) {
          this.logger.warn("Flush during reset failed, continuing anyway", {
            error: flushResult.err.message,
          })
        }

        // 2. Check for remaining records
        const [usageCount, verificationCount] = await Promise.all([
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.usageRecords)
            .then((r) => r[0]?.count ?? 0),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(schema.verifications)
            .then((r) => r[0]?.count ?? 0),
        ])

        if (usageCount > 0 || verificationCount > 0) {
          return Err(
            new UnPriceEntitlementStorageError({
              message: `Cannot reset: ${usageCount} usage records and ${verificationCount} verifications pending`,
            })
          )
        }

        // 3. Clear everything and reinitialize
        this.stateCache.clear()
        await this.storage.deleteAll()
        this.initialized = false
        this.resetInMemoryCursors()

        // Reinitialize
        await migrate(this.db, migrations)
        await this.loadStateCache()
        // No need to load cursors as we just reset them
        this.initialized = true

        return Ok(undefined)
      } catch (error) {
        return this.logAndError("reset", error)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Batch Fetching
  // ─────────────────────────────────────────────────────────────────────────────

  private async fetchUsageBatch(): Promise<BatchResult<UsageRecord>> {
    const records = await this.db
      .select()
      .from(schema.usageRecords)
      .orderBy(schema.usageRecords.seq)
      .limit(BATCH_SIZE)

    if (records.length === 0) {
      return { records: [], firstSeq: null, lastSeq: null }
    }

    const firstSeq = records[0]?.seq ?? null
    const lastSeq = records[records.length - 1]?.seq ?? null

    return { records, firstSeq, lastSeq }
  }

  private async fetchVerificationBatch(): Promise<BatchResult<Verification>> {
    const records = await this.db
      .select()
      .from(schema.verifications)
      .orderBy(schema.verifications.seq)
      .limit(BATCH_SIZE)

    if (records.length === 0) {
      return { records: [], firstSeq: null, lastSeq: null }
    }

    const firstSeq = records[0]?.seq ?? null
    const lastSeq = records[records.length - 1]?.seq ?? null

    return { records, firstSeq, lastSeq }
  }

  private async getXxhash(): Promise<XXHashAPI> {
    if (!this.xxhashInstance) {
      this.xxhashInstance = await xxhash()
    }
    return this.xxhashInstance
  }

  private buildLakehouseUsageRecords(records: UsageRecord[]): LakehouseUsageEvent[] {
    return records.map((record) => ({
      id: String(record.id),
      event_date: toEventDate(record.timestamp),
      request_id: String(record.request_id),
      project_id: String(record.project_id),
      customer_id: String(record.customer_id),
      timestamp: Number(record.timestamp),
      allowed: record.deleted === 0,
      idempotence_key: String(record.idempotence_key),
      feature_slug: String(record.feature_slug),
      usage: Number(record.usage ?? 0),
      entitlement_id: String(record.entitlement_id),
      deleted: Number(record.deleted),
      meta_id: String(record.meta_id ?? "0"),
      country: String(record.country ?? "UNK"),
      region: String(record.region ?? "UNK"),
      action: record.action ? String(record.action) : undefined,
      key_id: record.key_id ? String(record.key_id) : undefined,
      unit_of_measure: "unit",
      cost:
        record.cost != null && Number.isFinite(Number(record.cost))
          ? Number(record.cost)
          : undefined,
      rate_amount:
        record.rate_amount != null && Number.isFinite(Number(record.rate_amount))
          ? Number(record.rate_amount)
          : undefined,
      rate_currency: record.rate_currency ? String(record.rate_currency) : undefined,
      schema_version: Number(USAGE_SCHEMA_VERSION),
    }))
  }

  private buildLakehouseVerificationRecords(records: Verification[]): LakehouseVerificationEvent[] {
    return records.map((record) => ({
      id: String(record.id),
      event_date: toEventDate(record.timestamp),
      project_id: String(record.project_id),
      denied_reason: record.denied_reason ? String(record.denied_reason) : undefined,
      allowed: record.allowed === 1,
      timestamp: Number(record.timestamp),
      entitlement_id: String(record.entitlement_id),
      latency: record.latency ? Number(record.latency) : undefined,
      feature_slug: String(record.feature_slug),
      customer_id: String(record.customer_id),
      request_id: String(record.request_id),
      country: String(record.country ?? "UNK"),
      region: String(record.region ?? "UNK"),
      meta_id: String(record.meta_id ?? "0"),
      action: record.action ? String(record.action) : undefined,
      key_id: record.key_id ? String(record.key_id) : undefined,
      usage:
        record.usage != null && Number.isFinite(Number(record.usage))
          ? Number(record.usage)
          : undefined,
      remaining:
        record.remaining != null && Number.isFinite(Number(record.remaining))
          ? Number(record.remaining)
          : undefined,
      schema_version: Number(VERIFICATION_SCHEMA_VERSION),
    }))
  }

  private async fetchMetadataRowsByRefs(metadataIds: string[]): Promise<
    Array<{
      id: string
      payload: string
      project_id: string
      customer_id: string
      timestamp: number
    }>
  > {
    if (metadataIds.length === 0) {
      return []
    }

    const idList = Array.from(new Set(metadataIds))
    const chunkSize = 300
    const rowsById = new Map<
      string,
      {
        id: string
        payload: string
        project_id: string
        customer_id: string
        timestamp: number
      }
    >()

    for (let i = 0; i < idList.length; i += chunkSize) {
      const chunk = idList.slice(i, i + chunkSize)
      const chunkRows = await this.db
        .select({
          id: schema.metadataRecords.id,
          payload: schema.metadataRecords.payload,
          project_id: schema.metadataRecords.project_id,
          customer_id: schema.metadataRecords.customer_id,
          timestamp: schema.metadataRecords.timestamp,
        })
        .from(schema.metadataRecords)
        .where(inArray(schema.metadataRecords.id, chunk))

      for (const row of chunkRows) {
        const existing = rowsById.get(row.id)
        if (!existing || row.timestamp > existing.timestamp) {
          rowsById.set(row.id, row)
        }
      }
    }

    return Array.from(rowsById.values())
  }

  private buildLakehouseMetadataRecords(
    rows: Array<{
      id: string
      payload: string
      project_id: string
      customer_id: string
      timestamp: number
    }>
  ): LakehouseMetadataEvent[] {
    return rows.map((row) => ({
      id: String(row.id),
      event_date: toEventDate(row.timestamp),
      project_id: String(row.project_id),
      customer_id: String(row.customer_id),
      payload: row.payload,
      timestamp: Number(row.timestamp),
      schema_version: Number(METADATA_SCHEMA_VERSION),
    }))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tinybird Ingestion
  // ─────────────────────────────────────────────────────────────────────────────

  private async ingestUsageToTinybird(records: UsageRecord[]): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload = records.map((record) => ({
        id: record.id,
        timestamp: record.timestamp,
        usage: Number(record.usage ?? 0),
        deleted: record.deleted,
        project_id: record.project_id,
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        created_at: record.created_at,
        idempotence_key: record.idempotence_key,
      }))

      const result = await this.analytics.ingestFeaturesUsage(payload)

      // Verify all rows were processed (either successful or quarantined)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

      if (quarantined > 0) {
        this.logger.warn("Tinybird usage rows quarantined", {
          expected: records.length,
          successful,
          quarantined,
        })
      }

      if (total >= records.length) {
        return { success: true }
      }

      this.logger.warn("Tinybird usage ingestion incomplete", {
        expected: records.length,
        successful,
        quarantined,
      })
      return { success: false }
    } catch (error) {
      this.logger.error("Failed to ingest usage to Tinybird", { error: this.errorMessage(error) })
      return { success: false }
    }
  }

  private async ingestVerificationsToTinybird(
    records: Verification[]
  ): Promise<{ success: boolean }> {
    if (records.length === 0) return { success: true }

    try {
      const payload = records.map((record) => ({
        timestamp: record.timestamp,
        latency: record.latency ? Number(record.latency) : 0,
        denied_reason: record.denied_reason ?? undefined,
        allowed: record.allowed,
        project_id: record.project_id,
        customer_id: record.customer_id,
        feature_slug: record.feature_slug,
        created_at: record.created_at,
        region: record.region ?? "UNK",
      }))

      const result = await this.analytics.ingestFeaturesVerification(payload)

      // Verify all rows were processed
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0
      const total = successful + quarantined

      if (quarantined > 0) {
        this.logger.warn("Tinybird verification rows quarantined", {
          expected: records.length,
          successful,
          quarantined,
        })
      }

      if (total >= records.length) {
        return { success: true }
      }

      this.logger.warn("Tinybird verification ingestion incomplete", {
        expected: records.length,
        successful,
        quarantined,
      })
      return { success: false }
    } catch (error) {
      this.logger.error("Failed to ingest verifications to Tinybird", {
        error: this.errorMessage(error),
      })
      return { success: false }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Record Deletion
  // ─────────────────────────────────────────────────────────────────────────────

  private async deleteUsageRecordsBatch(firstSeq: number, lastSeq: number): Promise<number> {
    const result = await this.db
      .delete(schema.usageRecords)
      .where(
        sql`${schema.usageRecords.seq} >= ${firstSeq} AND ${schema.usageRecords.seq} <= ${lastSeq}`
      )
      .returning({ id: schema.usageRecords.id })

    return result.length
  }

  private async deleteVerificationRecordsBatch(firstSeq: number, lastSeq: number): Promise<number> {
    const result = await this.db
      .delete(schema.verifications)
      .where(
        sql`${schema.verifications.seq} >= ${firstSeq} AND ${schema.verifications.seq} <= ${lastSeq}`
      )
      .returning({ id: schema.verifications.id })

    return result.length
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // R2 Lakehouse
  // ─────────────────────────────────────────────────────────────────────────────

  private async buildEntitlementSnapshots(params: {
    prepared: LakehousePreparedPayload
    seenSnapshotSet: Set<string>
  }): Promise<EntitlementSnapshotBuildResult> {
    const referencedEntitlementIds = new Set<string>()

    for (const record of params.prepared.usageRecords) {
      if (record.entitlement_id && record.entitlement_id.length > 0) {
        referencedEntitlementIds.add(record.entitlement_id)
      }
    }

    for (const record of params.prepared.verificationRecords) {
      if (record.entitlement_id && record.entitlement_id.length > 0) {
        referencedEntitlementIds.add(record.entitlement_id)
      }
    }

    if (referencedEntitlementIds.size === 0) {
      return { snapshots: [], emittedSnapshotIds: new Set() }
    }

    const statesResult = await this.getAll()
    if (statesResult.err) {
      this.logger.warn("Failed to load entitlement states for lakehouse snapshot emission", {
        error: statesResult.err.message,
      })
      return { snapshots: [], emittedSnapshotIds: new Set() }
    }

    const stateByEntitlementId = new Map<string, EntitlementState>()
    for (const state of statesResult.val) {
      if (!stateByEntitlementId.has(state.id)) {
        stateByEntitlementId.set(state.id, state)
      }
    }

    const snapshots: LakehouseEntitlementSnapshotEvent[] = []
    const emittedSnapshotIds = new Set<string>()
    const missingStates: string[] = []

    for (const entitlementId of referencedEntitlementIds) {
      if (params.seenSnapshotSet.has(entitlementId)) {
        continue
      }

      const state = stateByEntitlementId.get(entitlementId)
      if (!state) {
        missingStates.push(entitlementId)
        continue
      }

      const timestamp =
        typeof state.computedAt === "number" && Number.isFinite(state.computedAt)
          ? state.computedAt
          : Date.now()

      const normalizedGrants = normalizeJsonValue(state.grants)
      const normalizedResetConfig = normalizeJsonValue(state.resetConfig ?? null)
      const normalizedMetadata = normalizeJsonValue(state.metadata ?? null)

      snapshots.push({
        id: String(state.id),
        event_date: toEventDate(timestamp), // Pipeline expects timestamp (int64), not date string
        project_id: String(state.projectId),
        customer_id: String(state.customerId),
        timestamp: Number(timestamp), // Ensure it's a number (int64)
        feature_slug: String(state.featureSlug),
        feature_type: String(state.featureType),
        unit_of_measure: String(state.unitOfMeasure || "unit"),
        reset_config: normalizedResetConfig,
        aggregation_method: String(state.aggregationMethod),
        merging_policy: state.mergingPolicy ? String(state.mergingPolicy) : undefined,
        limit: state.limit != null ? Number(state.limit) : undefined, // Ensure it's a number (int64)
        effective_at: Number(state.effectiveAt), // Ensure it's a number (timestamp)
        expires_at: state.expiresAt != null ? Number(state.expiresAt) : undefined, // Ensure it's a number (timestamp)
        version: state.version ? String(state.version) : undefined,
        grants: normalizedGrants,
        metadata: normalizedMetadata,
        schema_version: Number(ENTITLEMENT_SNAPSHOT_SCHEMA_VERSION), // Ensure it's a number (int32)
      })
      emittedSnapshotIds.add(entitlementId)
    }

    if (missingStates.length > 0) {
      this.logger.warn("Missing entitlement state for lakehouse snapshot emission", {
        missing_count: missingStates.length,
      })
    }

    return { snapshots, emittedSnapshotIds }
  }

  private async flushToR2(
    prepared: LakehousePreparedPayload,
    entitlementSnapshots: LakehouseEntitlementSnapshotEvent[]
  ): Promise<{ success: boolean }> {
    try {
      if (
        prepared.usageRecords.length === 0 &&
        prepared.verificationRecords.length === 0 &&
        prepared.metadataRecords.length === 0 &&
        entitlementSnapshots.length === 0
      ) {
        return { success: true }
      }

      this.logger.info("Flushing lakehouse payload", {
        usage_records: prepared.usageRecords.length,
        verification_records: prepared.verificationRecords.length,
        metadata_records: prepared.metadataRecords.length,
        entitlement_snapshot_records: entitlementSnapshots.length,
      })

      const lakehouseResult = await this.lakehouseService.flushRaw({
        cursorState: prepared.cursorState,
        usageRecords: prepared.usageRecords,
        verificationRecords: prepared.verificationRecords,
        metadataRecords: prepared.metadataRecords,
        entitlementSnapshots,
      })

      this.logger.info("Lakehouse payload flush successfully", {
        success: lakehouseResult.success,
        usage_records_sent: prepared.usageRecords.length,
        verification_records_sent: prepared.verificationRecords.length,
        metadata_records_sent: prepared.metadataRecords.length,
        entitlement_snapshot_records_sent: entitlementSnapshots.length,
      })

      if (!lakehouseResult.success) {
        this.logger.error("Lakehouse flush returned success=false")
      }

      return { success: lakehouseResult.success }
    } catch (error) {
      this.logger.error("Failed to flush to R2", {
        error: this.errorMessage(error),
        error_stack: error instanceof Error ? error.stack : undefined,
        error_name: error instanceof Error ? error.name : undefined,
        usage_records_count: prepared.usageRecords.length,
        verification_records_count: prepared.verificationRecords.length,
        metadata_records_count: prepared.metadataRecords.length,
        entitlement_snapshot_records_count: entitlementSnapshots.length,
      })
      return { success: false }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Seen Metadata Management
  // ─────────────────────────────────────────────────────────────────────────────

  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private getRetentionCutoffDate(currentDateStr: string): string {
    const cutoffDate = new Date(`${currentDateStr}T00:00:00.000Z`)
    const retentionWindowDays = METADATA_RETENTION_DAYS <= 1 ? 0 : METADATA_RETENTION_DAYS - 1
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionWindowDays)
    return cutoffDate.toISOString().slice(0, 10)
  }

  private async getSeenMetaSet(date: string): Promise<Set<string>> {
    return await this.doKernel.getDedupeSet(DEDUPE_SCOPE_METADATA, date)
  }

  private async getSeenSnapshotSet(date: string): Promise<Set<string>> {
    return await this.doKernel.getDedupeSet(DEDUPE_SCOPE_SNAPSHOT, date)
  }

  private async insertDedupeIds(params: {
    scope: string
    date: string
    ids: Set<string>
  }): Promise<void> {
    if (params.ids.size === 0) return

    await this.doKernel.putDedupeIds({
      scope: params.scope,
      eventDate: params.date,
      ids: params.ids,
      chunkSize: 500,
    })
  }

  private async updateSeenMetaSet(date: string, metaIds: Set<string>): Promise<void> {
    await this.insertDedupeIds({
      scope: DEDUPE_SCOPE_METADATA,
      date,
      ids: metaIds,
    })

    await this.rotateSeenMetadata(date)
  }

  private async updateSeenSnapshotSet(date: string, snapshotIds: Set<string>): Promise<void> {
    await this.insertDedupeIds({
      scope: DEDUPE_SCOPE_SNAPSHOT,
      date,
      ids: snapshotIds,
    })

    await this.rotateSeenSnapshots(date)
  }

  private async rotateSeenMetadata(currentDateStr: string): Promise<void> {
    try {
      const cutoffDate = this.getRetentionCutoffDate(currentDateStr)
      await this.doKernel.rotateDedupe(DEDUPE_SCOPE_METADATA, cutoffDate)
    } catch (error) {
      this.logger.error("Failed to rotate seen metadata", { error: this.errorMessage(error) })
    }
  }

  private async rotateSeenSnapshots(currentDateStr: string): Promise<void> {
    try {
      const cutoffDate = this.getRetentionCutoffDate(currentDateStr)
      await this.doKernel.rotateDedupe(DEDUPE_SCOPE_SNAPSHOT, cutoffDate)
    } catch (error) {
      this.logger.error("Failed to rotate seen snapshots", { error: this.errorMessage(error) })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Buffer Stats (Real-time Metrics)
  // ─────────────────────────────────────────────────────────────────────────────

  async getFlushPressure(): Promise<Result<FlushPressureStats, UnPriceEntitlementStorageError>> {
    try {
      this.assertInitialized()

      const [usageStats, verificationStats] = await Promise.all([
        this.db
          .select({
            count: sql<number>`count(*)`,
            oldestTimestamp: sql<number | null>`min(${schema.usageRecords.timestamp})`,
          })
          .from(schema.usageRecords),
        this.db
          .select({
            count: sql<number>`count(*)`,
            oldestTimestamp: sql<number | null>`min(${schema.verifications.timestamp})`,
          })
          .from(schema.verifications),
      ])

      const pendingUsageRecords = usageStats[0]?.count ?? 0
      const pendingVerificationRecords = verificationStats[0]?.count ?? 0
      const pendingTotalRecords = pendingUsageRecords + pendingVerificationRecords

      const usageOldest = usageStats[0]?.oldestTimestamp ?? null
      const verificationOldest = verificationStats[0]?.oldestTimestamp ?? null

      const oldestPendingTimestamp =
        usageOldest === null
          ? verificationOldest
          : verificationOldest === null
            ? usageOldest
            : Math.min(usageOldest, verificationOldest)

      const oldestPendingAgeSeconds = oldestPendingTimestamp
        ? Math.max(0, Math.floor((Date.now() - oldestPendingTimestamp) / 1000))
        : 0

      return Ok({
        pendingUsageRecords,
        pendingVerificationRecords,
        pendingTotalRecords,
        oldestPendingTimestamp,
        oldestPendingAgeSeconds,
      })
    } catch (error) {
      return this.logAndError("getFlushPressure", error)
    }
  }

  /**
   * Returns aggregated statistics for unflushed records in the DO SQLite buffer.
   * This is used for real-time metrics without querying Tinybird.
   *
   * Returns counts and aggregations of pending usage/verification records that
   * haven't been flushed to Tinybird/R2 yet (typically seconds to minutes old).
   */
  async getBufferStats(windowSeconds = WINDOW_60_MIN): Promise<
    Result<
      {
        usageCount: number
        verificationCount: number
        totalUsage: number
        allowedCount: number
        deniedCount: number
        limitExceededCount: number
        bucketSizeSeconds: number
        featureStats: Array<{
          featureSlug: string
          usageCount: number
          verificationCount: number
          totalUsage: number
        }>
        usageSeries: Array<{
          bucketStart: number
          usageCount: number
          totalUsage: number
        }>
        verificationSeries: Array<{
          bucketStart: number
          verificationCount: number
          allowedCount: number
          deniedCount: number
          limitExceededCount: number
        }>
        oldestTimestamp: number | null
        newestTimestamp: number | null
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      this.assertInitialized()

      const normalizedWindowSeconds =
        windowSeconds === WINDOW_5_MIN ||
        windowSeconds === WINDOW_60_MIN ||
        windowSeconds === WINDOW_1_DAY ||
        windowSeconds === WINDOW_7_DAYS
          ? windowSeconds
          : WINDOW_60_MIN

      const selectedBucketSizeSeconds =
        normalizedWindowSeconds <= WINDOW_5_MIN
          ? MINUTE_BUCKET_SECONDS
          : normalizedWindowSeconds <= WINDOW_60_MIN
            ? FIVE_MIN_BUCKET_SECONDS
            : normalizedWindowSeconds <= WINDOW_1_DAY
              ? HOUR_BUCKET_SECONDS
              : DAY_BUCKET_SECONDS
      const now = Date.now()
      const windowStart = now - normalizedWindowSeconds * 1000

      const usageSeries = await this.db
        .select({
          bucketStart: schema.usageAggregates.bucket_start,
          usageCount: sql<number>`sum(${schema.usageAggregates.usage_count})`,
          totalUsage: sql<number>`coalesce(sum(cast(${schema.usageAggregates.total_usage} as real)), 0)`,
        })
        .from(schema.usageAggregates)
        .where(
          sql`${schema.usageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.usageAggregates.bucket_start} >= ${windowStart} AND ${schema.usageAggregates.bucket_start} <= ${now}`
        )
        .groupBy(schema.usageAggregates.bucket_start)
        .orderBy(schema.usageAggregates.bucket_start)

      const verificationSeries = await this.db
        .select({
          bucketStart: schema.verificationAggregates.bucket_start,
          verificationCount: sql<number>`sum(${schema.verificationAggregates.verification_count})`,
          allowedCount: sql<number>`sum(${schema.verificationAggregates.allowed_count})`,
          deniedCount: sql<number>`sum(${schema.verificationAggregates.denied_count})`,
        })
        .from(schema.verificationAggregates)
        .where(
          sql`${schema.verificationAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.verificationAggregates.bucket_start} >= ${windowStart} AND ${schema.verificationAggregates.bucket_start} <= ${now}`
        )
        .groupBy(schema.verificationAggregates.bucket_start)
        .orderBy(schema.verificationAggregates.bucket_start)

      const reportUsageSeries = await this.db
        .select({
          bucketStart: schema.reportUsageAggregates.bucket_start,
          limitExceededCount: sql<number>`sum(${schema.reportUsageAggregates.limit_exceeded_count})`,
        })
        .from(schema.reportUsageAggregates)
        .where(
          sql`${schema.reportUsageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.reportUsageAggregates.bucket_start} >= ${windowStart} AND ${schema.reportUsageAggregates.bucket_start} <= ${now}`
        )
        .groupBy(schema.reportUsageAggregates.bucket_start)
        .orderBy(schema.reportUsageAggregates.bucket_start)

      const usageStatsByFeature = await this.db
        .select({
          featureSlug: schema.usageAggregates.feature_slug,
          usageCount: sql<number>`sum(${schema.usageAggregates.usage_count})`,
          totalUsage: sql<number>`coalesce(sum(cast(${schema.usageAggregates.total_usage} as real)), 0)`,
        })
        .from(schema.usageAggregates)
        .where(
          sql`${schema.usageAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.usageAggregates.bucket_start} >= ${windowStart} AND ${schema.usageAggregates.bucket_start} <= ${now}`
        )
        .groupBy(schema.usageAggregates.feature_slug)

      const verificationStatsByFeature = await this.db
        .select({
          featureSlug: schema.verificationAggregates.feature_slug,
          verificationCount: sql<number>`sum(${schema.verificationAggregates.verification_count})`,
          allowedCount: sql<number>`sum(${schema.verificationAggregates.allowed_count})`,
          deniedCount: sql<number>`sum(${schema.verificationAggregates.denied_count})`,
        })
        .from(schema.verificationAggregates)
        .where(
          sql`${schema.verificationAggregates.bucket_size_seconds} = ${selectedBucketSizeSeconds} AND ${schema.verificationAggregates.bucket_start} >= ${windowStart} AND ${schema.verificationAggregates.bucket_start} <= ${now}`
        )
        .groupBy(schema.verificationAggregates.feature_slug)

      // Combine stats by feature
      const featureMap = new Map<
        string,
        {
          featureSlug: string
          usageCount: number
          verificationCount: number
          totalUsage: number
        }
      >()

      let totalUsageCount = 0
      let totalUsageSum = 0
      let totalVerificationCount = 0
      let totalAllowed = 0
      let totalDenied = 0
      let totalLimitExceeded = 0
      let oldestTimestamp: number | null = null
      let newestTimestamp: number | null = null

      for (const stat of usageStatsByFeature) {
        totalUsageCount += stat.usageCount
        totalUsageSum += stat.totalUsage

        featureMap.set(stat.featureSlug, {
          featureSlug: stat.featureSlug,
          usageCount: stat.usageCount,
          verificationCount: 0,
          totalUsage: stat.totalUsage,
        })
      }

      for (const stat of verificationStatsByFeature) {
        totalVerificationCount += stat.verificationCount
        totalAllowed += stat.allowedCount ?? 0
        totalDenied += stat.deniedCount ?? 0

        const existing = featureMap.get(stat.featureSlug)
        if (existing) {
          existing.verificationCount = stat.verificationCount
        } else {
          featureMap.set(stat.featureSlug, {
            featureSlug: stat.featureSlug,
            usageCount: 0,
            verificationCount: stat.verificationCount,
            totalUsage: 0,
          })
        }
      }

      const reportUsageByBucket = new Map(
        reportUsageSeries.map((bucket) => [
          bucket.bucketStart,
          {
            limitExceededCount: bucket.limitExceededCount,
          },
        ])
      )

      for (const bucket of reportUsageSeries) {
        totalLimitExceeded += bucket.limitExceededCount
      }

      const verificationSeriesMap = new Map(
        verificationSeries.map((bucket) => [
          bucket.bucketStart,
          {
            ...bucket,
            limitExceededCount: 0,
          },
        ])
      )

      for (const [bucketStart, reportUsage] of reportUsageByBucket) {
        const existing = verificationSeriesMap.get(bucketStart)
        if (existing) {
          existing.limitExceededCount = reportUsage.limitExceededCount
        } else {
          verificationSeriesMap.set(bucketStart, {
            bucketStart,
            verificationCount: 0,
            allowedCount: 0,
            deniedCount: 0,
            limitExceededCount: reportUsage.limitExceededCount,
          })
        }
      }

      const verificationSeriesRows = Array.from(verificationSeriesMap.values()).sort(
        (a, b) => a.bucketStart - b.bucketStart
      )

      const usageOldest = usageSeries[0]?.bucketStart ?? null
      const verificationOldest = verificationSeries[0]?.bucketStart ?? null
      const usageNewest = usageSeries[usageSeries.length - 1]?.bucketStart ?? null
      const verificationNewest =
        verificationSeries[verificationSeries.length - 1]?.bucketStart ?? null

      oldestTimestamp =
        usageOldest === null
          ? verificationOldest
          : verificationOldest === null
            ? usageOldest
            : Math.min(usageOldest, verificationOldest)

      newestTimestamp =
        usageNewest === null
          ? verificationNewest
          : verificationNewest === null
            ? usageNewest
            : Math.max(usageNewest, verificationNewest)

      return Ok({
        usageCount: totalUsageCount,
        verificationCount: totalVerificationCount,
        totalUsage: totalUsageSum,
        allowedCount: totalAllowed,
        deniedCount: totalDenied,
        limitExceededCount: totalLimitExceeded,
        bucketSizeSeconds: selectedBucketSizeSeconds,
        featureStats: Array.from(featureMap.values()),
        usageSeries,
        verificationSeries: verificationSeriesRows,
        oldestTimestamp,
        newestTimestamp,
      })
    } catch (error) {
      return this.logAndError("getBufferStats", error)
    }
  }

  private async updateUsageAggregates(data: {
    timestamp: number
    featureSlug: string
    usage: number
  }): Promise<void> {
    const now = Date.now()

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds, now)

      await this.db
        .insert(schema.usageAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          usage_count: 1,
          total_usage: String(data.usage),
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.usageAggregates.bucket_start,
            schema.usageAggregates.bucket_size_seconds,
            schema.usageAggregates.feature_slug,
          ],
          set: {
            usage_count: sql`${schema.usageAggregates.usage_count} + 1`,
            total_usage: sql`cast(${schema.usageAggregates.total_usage} as real) + ${data.usage}`,
            updated_at: now,
          },
        })
    }
  }

  private async updateReportUsageAggregates(data: {
    timestamp: number
    featureSlug: string
    reportUsage: number
    limitExceeded: number
  }): Promise<void> {
    const now = Date.now()

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds, now)

      await this.db
        .insert(schema.reportUsageAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          report_usage_count: data.reportUsage,
          limit_exceeded_count: data.limitExceeded,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.reportUsageAggregates.bucket_start,
            schema.reportUsageAggregates.bucket_size_seconds,
            schema.reportUsageAggregates.feature_slug,
          ],
          set: {
            report_usage_count: sql`${schema.reportUsageAggregates.report_usage_count} + ${data.reportUsage}`,
            limit_exceeded_count: sql`${schema.reportUsageAggregates.limit_exceeded_count} + ${data.limitExceeded}`,
            updated_at: now,
          },
        })
    }
  }

  private async updateVerificationAggregates(data: {
    timestamp: number
    featureSlug: string
    allowed: number
  }): Promise<void> {
    const now = Date.now()
    const allowedDelta = data.allowed === 1 ? 1 : 0
    const deniedDelta = data.allowed === 1 ? 0 : 1

    for (const bucketSizeSeconds of AGGREGATE_BUCKETS) {
      const bucketStart = this.getBucketStart(data.timestamp, bucketSizeSeconds, now)

      await this.db
        .insert(schema.verificationAggregates)
        .values({
          bucket_start: bucketStart,
          bucket_size_seconds: bucketSizeSeconds,
          feature_slug: data.featureSlug,
          verification_count: 1,
          allowed_count: allowedDelta,
          denied_count: deniedDelta,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.verificationAggregates.bucket_start,
            schema.verificationAggregates.bucket_size_seconds,
            schema.verificationAggregates.feature_slug,
          ],
          set: {
            verification_count: sql`${schema.verificationAggregates.verification_count} + 1`,
            allowed_count: sql`${schema.verificationAggregates.allowed_count} + ${allowedDelta}`,
            denied_count: sql`${schema.verificationAggregates.denied_count} + ${deniedDelta}`,
            updated_at: now,
          },
        })
    }
  }

  private getBucketStart(timestamp: number, bucketSizeSeconds: number, nowMs = Date.now()): number {
    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : nowMs
    const normalizedTimestamp = Math.min(safeTimestamp, nowMs)
    const bucketSizeMs = bucketSizeSeconds * 1000
    return Math.floor(normalizedTimestamp / bucketSizeMs) * bucketSizeMs
  }

  private async pruneAggregateBuckets(nowMs: number): Promise<void> {
    const minuteCutoff = nowMs - MINUTE_AGGREGATE_RETENTION_SECONDS * 1000
    const fiveMinuteCutoff = nowMs - FIVE_MIN_AGGREGATE_RETENTION_SECONDS * 1000
    const hourCutoff = nowMs - HOUR_AGGREGATE_RETENTION_SECONDS * 1000
    const dayCutoff = nowMs - DAY_AGGREGATE_RETENTION_SECONDS * 1000

    await Promise.all([
      this.db
        .delete(schema.usageAggregates)
        .where(
          sql`(${schema.usageAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${hourCutoff}) OR (${schema.usageAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.usageAggregates.bucket_start} < ${dayCutoff})`
        ),
      this.db
        .delete(schema.verificationAggregates)
        .where(
          sql`(${schema.verificationAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${hourCutoff}) OR (${schema.verificationAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.verificationAggregates.bucket_start} < ${dayCutoff})`
        ),
      this.db
        .delete(schema.reportUsageAggregates)
        .where(
          sql`(${schema.reportUsageAggregates.bucket_size_seconds} = ${MINUTE_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${minuteCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${FIVE_MIN_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${fiveMinuteCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${HOUR_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${hourCutoff}) OR (${schema.reportUsageAggregates.bucket_size_seconds} = ${DAY_BUCKET_SECONDS} AND ${schema.reportUsageAggregates.bucket_start} < ${dayCutoff})`
        ),
    ])
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Helper to generate keys
   */
  public makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${STATE_KEY_PREFIX}${params.projectId}:${params.customerId}:${params.featureSlug}`
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown"
  }

  private logAndError<T>(
    operation: string,
    error: unknown
  ): Result<T, UnPriceEntitlementStorageError> {
    const message = this.errorMessage(error)
    this.logger.error(`Storage provider ${this.state.id.toString()} ${operation} failed`, {
      error: message,
    })
    return Err(new UnPriceEntitlementStorageError({ message: `${operation} failed: ${message}` }))
  }
}
