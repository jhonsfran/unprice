import type { Pipeline } from "cloudflare:pipelines"
import type { AnalyticsFeatureMetadata } from "@unprice/analytics"
import type {
  LakehouseCursorState,
  LakehouseFlushInput,
  LakehouseFlushResult,
  LakehouseJsonValue,
  LakehouseMetadataEvent,
  LakehouseService,
  LakehouseUsageEvent,
  LakehouseVerificationEvent,
} from "@unprice/lakehouse"
import {
  LAKEHOUSE_INTERNAL_METADATA_KEYS,
  getLakehouseSourceCurrentVersion,
  getLakehouseSourceEventZodSchema,
} from "@unprice/lakehouse"
import type { Logger } from "@unprice/logging"
import type { UsageRecord, Verification } from "~/db/types"

type IndexedSource = "usage" | "verification" | "metadata" | "entitlement_snapshot"

interface LakehouseProcessedUsageRecord {
  record: UsageRecord
  metaId: number
  country: string
  region: string
  action: string | undefined
  keyId: string | undefined
}

interface LakehouseProcessedVerificationRecord {
  record: Verification
  metaId: number
  region: string
  country: string
  action: string | undefined
  keyId: string | undefined
}

interface LakehouseMetadataProcessingResult {
  usageRecords: LakehouseProcessedUsageRecord[]
  verificationRecords: LakehouseProcessedVerificationRecord[]
  uniqueMetadata: AnalyticsFeatureMetadata[]
  seenMetaSet: Set<string>
  todayKey: string
}

interface LakehousePreparedPayload {
  cursorState: LakehouseCursorState
  usageRecords: LakehouseUsageEvent[]
  verificationRecords: LakehouseVerificationEvent[]
  metadataRecords: LakehouseMetadataEvent[]
}

export interface LakehouseMetadataBuildParams {
  usageRecords: UsageRecord[]
  verificationRecords: Verification[]
  seenMetaSet: Set<string>
  todayKey: string
  hashMetadataJson(metadataJson: string): Promise<bigint>
}

export interface LakehousePipelines {
  usage: Pipeline
  verification: Pipeline
  metadata: Pipeline
  entitlement_snapshot: Pipeline
}

const INTERNAL_METADATA_KEYS = new Set<string>(LAKEHOUSE_INTERNAL_METADATA_KEYS)
const USAGE_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("usage")
const VERIFICATION_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("verification")
const METADATA_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("metadata")

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseVerificationCursorValue(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid verification id: ${value}`)
  }
  return parsed
}

export function toEventDate(timestamp: number): string {
  // Zod schema expects event_date as datetime (string YYYY-MM-DD format)
  // This matches the registry definition: "UTC date partition key formatted as YYYY-MM-DD"
  return new Date(timestamp).toISOString().slice(0, 10)
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function extractTagMetadata(
  metadata: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!metadata) {
    return null
  }

  const tagEntries = Object.entries(metadata).filter(([key]) => !INTERNAL_METADATA_KEYS.has(key))
  if (tagEntries.length === 0) {
    return null
  }

  return Object.fromEntries(tagEntries)
}

function toStableMetadataJson(metadata: Record<string, unknown> | null): LakehouseJsonValue {
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

export async function buildLakehouseMetadataProcessingResult(
  params: LakehouseMetadataBuildParams
): Promise<LakehouseMetadataProcessingResult> {
  const uniqueMetadata: AnalyticsFeatureMetadata[] = []
  const processedUsage: LakehouseProcessedUsageRecord[] = []
  const processedVerifications: LakehouseProcessedVerificationRecord[] = []

  for (const record of params.usageRecords) {
    const metadata = extractTagMetadata(parseMetadata(record.metadata))
    const metadataJson = toStableMetadataJson(metadata)
    const hash =
      metadataJson === "{}" ? BigInt(0) : await params.hashMetadataJson(String(metadataJson))
    const metaId = Number(hash)
    const metaIdKey = hash.toString()

    if (hash !== BigInt(0) && !params.seenMetaSet.has(metaIdKey)) {
      params.seenMetaSet.add(metaIdKey)
      uniqueMetadata.push({
        meta_id: metaId,
        tags: String(metadataJson),
        project_id: record.project_id,
        customer_id: record.customer_id,
        timestamp: record.timestamp,
      })
    }

    processedUsage.push({
      record,
      metaId,
      country: record.country ?? "UNK",
      region: record.region ?? "UNK",
      action: record.action ?? undefined,
      keyId: record.key_id ?? undefined,
    })
  }

  for (const record of params.verificationRecords) {
    const metadata = extractTagMetadata(parseMetadata(record.metadata))
    const metadataJson = toStableMetadataJson(metadata)
    const hash =
      metadataJson === "{}" ? BigInt(0) : await params.hashMetadataJson(String(metadataJson))
    const metaId = Number(hash)
    const metaIdKey = hash.toString()

    if (hash !== BigInt(0) && !params.seenMetaSet.has(metaIdKey)) {
      params.seenMetaSet.add(metaIdKey)
      uniqueMetadata.push({
        meta_id: metaId,
        tags: String(metadataJson),
        project_id: record.project_id,
        customer_id: record.customer_id,
        timestamp: record.timestamp,
      })
    }

    processedVerifications.push({
      record,
      metaId,
      region: record.region ?? "UNK",
      country: record.country ?? "UNK",
      action: record.action ?? undefined,
      keyId: record.key_id ?? undefined,
    })
  }

  return {
    usageRecords: processedUsage,
    verificationRecords: processedVerifications,
    uniqueMetadata,
    seenMetaSet: params.seenMetaSet,
    todayKey: params.todayKey,
  }
}

export function buildLakehousePreparedPayload(params: {
  processed: LakehouseMetadataProcessingResult
  cursorState: LakehouseCursorState
}): LakehousePreparedPayload {
  const newUsageRecords = params.processed.usageRecords.filter((record) => {
    if (!params.cursorState.lastR2UsageId) return true
    return record.record.id > params.cursorState.lastR2UsageId
  })

  const newVerificationRecords = params.processed.verificationRecords.filter((record) => {
    if (params.cursorState.lastR2VerificationId === null) return true
    return record.record.id > params.cursorState.lastR2VerificationId
  })

  const usageRecords: LakehouseUsageEvent[] = newUsageRecords.map(
    ({ record, metaId, region, action, keyId, country }) => ({
      id: String(record.id),
      event_date: toEventDate(record.timestamp), // Zod schema expects datetime (string YYYY-MM-DD), not timestamp
      request_id: String(record.request_id),
      project_id: String(record.project_id),
      customer_id: String(record.customer_id),
      timestamp: Number(record.timestamp), // Ensure it's a number (int64)
      allowed: record.deleted === 0,
      idempotence_key: String(record.idempotence_key),
      feature_slug: String(record.feature_slug),
      usage: Number(record.usage ?? 0),
      entitlement_id: String(record.entitlement_id),
      deleted: Number(record.deleted), // Ensure it's a number (int64)
      meta_id: String(metaId),
      country: String(country ?? record.country ?? "UNK"),
      region: String(region ?? record.region ?? "UNK"),
      action: action ? String(action) : undefined,
      key_id: keyId ? String(keyId) : undefined,
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
      schema_version: Number(USAGE_SCHEMA_VERSION), // Ensure it's a number (int32)
    })
  )

  const verificationRecords: LakehouseVerificationEvent[] = newVerificationRecords.map(
    ({ record, metaId, region, action, keyId, country }) => ({
      id: String(record.id),
      event_date: toEventDate(record.timestamp), // Zod schema expects datetime (string YYYY-MM-DD), not timestamp
      project_id: String(record.project_id),
      denied_reason: record.denied_reason ? String(record.denied_reason) : undefined,
      allowed: record.allowed === 1,
      timestamp: Number(record.timestamp), // Ensure it's a number (int64)
      entitlement_id: String(record.entitlement_id),
      latency: record.latency ? Number(record.latency) : undefined,
      feature_slug: String(record.feature_slug),
      customer_id: String(record.customer_id),
      request_id: String(record.request_id),
      country: String(country ?? record.country ?? "UNK"),
      region: String(region ?? record.region ?? "UNK"),
      meta_id: String(metaId),
      action: action ? String(action) : undefined,
      key_id: keyId ? String(keyId) : undefined,
      usage:
        record.usage != null && Number.isFinite(Number(record.usage))
          ? Number(record.usage)
          : undefined,
      remaining:
        record.remaining != null && Number.isFinite(Number(record.remaining))
          ? Number(record.remaining)
          : undefined,
      schema_version: Number(VERIFICATION_SCHEMA_VERSION), // Ensure it's a number (int32)
      // TODO: add cost and rate_amount and rate_currency
      // TODO: we could simplify things by creating tables in the DO with entitlements and metadata
    })
  )

  const metadataRecords: LakehouseMetadataEvent[] = params.processed.uniqueMetadata.map(
    (entry) => ({
      id: String(entry.meta_id),
      event_date: toEventDate(entry.timestamp), // Zod schema expects datetime (string YYYY-MM-DD), not timestamp
      project_id: String(entry.project_id),
      customer_id: String(entry.customer_id),
      payload: toStableMetadataJson(parseMetadata(entry.tags)),
      timestamp: Number(entry.timestamp), // Ensure it's a number (int64)
      schema_version: Number(METADATA_SCHEMA_VERSION), // Ensure it's a number (int32)
    })
  )

  return {
    cursorState: params.cursorState,
    usageRecords,
    verificationRecords,
    metadataRecords,
  }
}

class LakehousePipelineSender {
  private readonly pipeline: Pipeline

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline
  }

  public async send(records: unknown[]): Promise<void> {
    // Ensure records are properly typed as Record<string, unknown>[]
    // Pipeline.send() expects PipelineRecord[] which is Record<string, unknown>[]
    if (records.length === 0) {
      return
    }

    // Validate that all records are objects
    const pipelineRecords: Array<Record<string, unknown>> = []
    for (const record of records) {
      if (record && typeof record === "object" && !Array.isArray(record)) {
        pipelineRecords.push(record as Record<string, unknown>)
      } else {
        throw new Error(
          `Invalid record type: expected object, got ${typeof record}. Record: ${JSON.stringify(record)}`
        )
      }
    }

    // Validate binding exists
    if (!this.pipeline || typeof this.pipeline.send !== "function") {
      throw new Error(
        `Pipeline is invalid: pipeline=${!!this.pipeline}, send=${typeof this.pipeline?.send}`
      )
    }

    try {
      await this.pipeline.send(pipelineRecords)
    } catch (error) {
      // Re-throw with more context
      throw new Error(
        `Pipeline.send() failed: ${error instanceof Error ? error.message : String(error)}. Records count: ${pipelineRecords.length}, First record keys: ${pipelineRecords[0] ? Object.keys(pipelineRecords[0]).join(", ") : "none"}`,
        { cause: error }
      )
    }
  }
}

export class LakehousePipelineService implements LakehouseService {
  private readonly sourceSenders: Record<IndexedSource, LakehousePipelineSender>
  private readonly logger: Logger
  private readonly sendRetryMaxAttempts = 3
  private readonly sendRetryBaseDelayMs = 250
  private readonly sendRetryMaxDelayMs = 2_000

  constructor(params: {
    logger: Logger
    pipelines: LakehousePipelines
  }) {
    this.logger = params.logger

    this.sourceSenders = {
      usage: new LakehousePipelineSender(params.pipelines.usage),
      verification: new LakehousePipelineSender(params.pipelines.verification),
      metadata: new LakehousePipelineSender(params.pipelines.metadata),
      entitlement_snapshot: new LakehousePipelineSender(params.pipelines.entitlement_snapshot),
    }
  }

  public async flushRaw(params: LakehouseFlushInput): Promise<LakehouseFlushResult> {
    try {
      const newUsageRecords = params.usageRecords.filter((record) => {
        if (!params.cursorState.lastR2UsageId) {
          return true
        }
        return record.id > params.cursorState.lastR2UsageId
      })

      const newVerificationRecords = params.verificationRecords.filter((record) => {
        if (params.cursorState.lastR2VerificationId === null) {
          return true
        }
        const cursorValue = parseVerificationCursorValue(record.id)
        return cursorValue > params.cursorState.lastR2VerificationId
      })

      this.logger.debug("Lakehouse flush input filtering complete", {
        cursor_lastR2UsageId: params.cursorState.lastR2UsageId,
        cursor_lastR2VerificationId: params.cursorState.lastR2VerificationId,
        input_usage_records: params.usageRecords.length,
        input_verification_records: params.verificationRecords.length,
        input_metadata_records: params.metadataRecords.length,
        input_entitlement_snapshot_records: params.entitlementSnapshots.length,
        new_usage_records: newUsageRecords.length,
        new_verification_records: newVerificationRecords.length,
      })

      if (
        newUsageRecords.length === 0 &&
        newVerificationRecords.length === 0 &&
        params.metadataRecords.length === 0 &&
        params.entitlementSnapshots.length === 0
      ) {
        return {
          success: true,
          cursorState: params.cursorState,
        }
      }

      const sourceBatches: Record<IndexedSource, unknown[]> = {
        usage: this.canonicalizeRecords("usage", newUsageRecords),
        verification: this.canonicalizeRecords("verification", newVerificationRecords),
        metadata: this.canonicalizeRecords("metadata", params.metadataRecords),
        entitlement_snapshot: this.canonicalizeRecords(
          "entitlement_snapshot",
          params.entitlementSnapshots
        ),
      }

      this.logger.debug("Lakehouse source batches prepared", {
        usage_count: sourceBatches.usage.length,
        verification_count: sourceBatches.verification.length,
        metadata_count: sourceBatches.metadata.length,
        entitlement_snapshot_count: sourceBatches.entitlement_snapshot.length,
      })

      await Promise.all(
        (Object.keys(sourceBatches) as IndexedSource[]).map((source) =>
          this.sendSourceRecords(source, sourceBatches[source])
        )
      )

      const nextUsageId =
        newUsageRecords.length > 0
          ? newUsageRecords.reduce(
              (max, item) => (item.id > max ? item.id : max),
              newUsageRecords[0]!.id
            )
          : params.cursorState.lastR2UsageId

      const nextVerificationId =
        newVerificationRecords.length > 0
          ? newVerificationRecords.reduce((max, item) => {
              const parsed = parseVerificationCursorValue(item.id)
              return parsed > max ? parsed : max
            }, params.cursorState.lastR2VerificationId ?? 0)
          : params.cursorState.lastR2VerificationId

      return {
        success: true,
        cursorState: {
          lastR2UsageId: nextUsageId,
          lastR2VerificationId: nextVerificationId,
        },
      }
    } catch (error) {
      this.logger.error("Failed to flush to lakehouse pipeline", {
        error: error instanceof Error ? error.message : "unknown",
        error_stack: error instanceof Error ? error.stack : undefined,
        error_name: error instanceof Error ? error.name : undefined,
        error_cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
        input_usage_records: params.usageRecords.length,
        input_verification_records: params.verificationRecords.length,
        input_metadata_records: params.metadataRecords.length,
        input_entitlement_snapshot_records: params.entitlementSnapshots.length,
      })

      // Re-throw the error so callers know it failed
      throw error
    }
  }

  private canonicalizeRecords(
    source: IndexedSource,
    records: unknown[]
  ): Record<string, unknown>[] {
    if (records.length === 0) {
      return []
    }

    const schema = getLakehouseSourceEventZodSchema(source)
    const accepted: Record<string, unknown>[] = []
    const rejectReasons = new Map<string, number>()

    for (const raw of records) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0]
        const path = firstIssue?.path?.length ? firstIssue.path.join(".") : "record"
        const reason = `${path}: ${firstIssue?.message ?? "invalid"}`
        rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1)
        continue
      }

      accepted.push(parsed.data as Record<string, unknown>)
    }

    const rejectedCount = records.length - accepted.length
    if (rejectedCount > 0) {
      const sortedReasons = Object.fromEntries(
        Array.from(rejectReasons.entries()).sort(([a], [b]) => a.localeCompare(b))
      )

      this.logger.error("Lakehouse records rejected by strict schema validation", {
        source,
        total: records.length,
        accepted: accepted.length,
        rejected: rejectedCount,
        reasons: JSON.stringify(sortedReasons),
      })

      throw new Error(
        `Lakehouse ${source} payload failed schema validation with ${rejectedCount} rejected records`
      )
    }

    this.logger.debug("Lakehouse records canonicalized", {
      source,
      total: records.length,
      accepted: accepted.length,
      rejected: rejectedCount,
    })

    return accepted
  }

  private async sendSourceRecords(source: IndexedSource, records: unknown[]): Promise<void> {
    if (records.length === 0) {
      return
    }

    const sender = this.sourceSenders[source]
    for (let attempt = 1; attempt <= this.sendRetryMaxAttempts; attempt++) {
      try {
        this.logger.debug("Sending lakehouse source records", {
          source,
          records_count: records.length,
          attempt,
          max_attempts: this.sendRetryMaxAttempts,
        })

        await sender.send(records)

        this.logger.info("Lakehouse source sent successfully", {
          source,
          records_count: records.length,
          attempts_used: attempt,
        })
        return
      } catch (error) {
        const isLastAttempt = attempt === this.sendRetryMaxAttempts

        if (isLastAttempt) {
          this.logger.error("Failed to send lakehouse source after retries", {
            source,
            records_count: records.length,
            attempts: attempt,
            error: error instanceof Error ? error.message : "unknown",
            error_stack: error instanceof Error ? error.stack : undefined,
            error_name: error instanceof Error ? error.name : undefined,
            error_cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
          })
          throw error
        }

        const retryDelayMs = this.getRetryDelayMs(attempt)
        this.logger.warn("Retrying lakehouse source send", {
          source,
          records_count: records.length,
          attempts: attempt,
          next_attempt: attempt + 1,
          retry_delay_ms: retryDelayMs,
          error: error instanceof Error ? error.message : "unknown",
        })
        await this.sleep(retryDelayMs)
      }
    }
  }

  private getRetryDelayMs(attempt: number): number {
    const exponentialDelay = this.sendRetryBaseDelayMs * 2 ** (attempt - 1)
    const jitterMs = Math.floor(Math.random() * 100)
    return Math.min(exponentialDelay + jitterMs, this.sendRetryMaxDelayMs)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
