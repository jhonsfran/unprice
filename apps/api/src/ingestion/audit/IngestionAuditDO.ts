import type { Pipeline, PipelineRecord } from "cloudflare:pipelines"
import { DurableObject } from "cloudflare:workers"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { and, asc, inArray, isNull, lt } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { createDoLogger, runDoOperation } from "~/observability"
import {
  ALARM_RETRY_DELAY_MS,
  AUDIT_PUBLISH_UPDATE_BATCH_SIZE,
  AUDIT_RETENTION_MS,
  BATCH_TABLE_NAME,
  OUTBOX_BATCH_SIZE,
  RETENTION_CLEANUP_BATCH_SIZE,
  STUCK_ROW_THRESHOLD_MS,
} from "./constants"
import { ingestionAuditBatchesTable, schema } from "./db/schema"
import migrations from "./drizzle/migrations"
import { type LedgerEntry, isLedgerEntry } from "./ledger-entry"
import { unique } from "./utils"

type AuditEntryIndexValue = {
  payloadHash: string
}

type CommitResult = {
  conflicts: number
  duplicates: number
  inserted: number
}

export class IngestionAuditDO extends DurableObject {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly ready: Promise<void>
  private readonly appEnv?: string
  private readonly localPipelineUrl?: string
  private readonly pipelineEvents?: Pipeline<PipelineRecord>
  private readonly logger: Logger
  private alarmScheduled = false
  private auditEntryIndex: Map<string, AuditEntryIndexValue> | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.appEnv = env.APP_ENV?.trim()
    this.localPipelineUrl = env.LOCAL_PIPELINE_URL?.trim()
    this.pipelineEvents = env.PIPELINE_EVENTS
    this.db = drizzle(this.ctx.storage, { schema, logger: false })

    const requestId = this.ctx.id.toString()
    this.logger = createDoLogger(requestId)
    this.logger.set({
      requestId,
      service: "ingestionaudit",
      request: { id: requestId },
      cloud: {
        platform: "cloudflare",
        durable_object_id: requestId,
      },
    })

    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
      this.hydrateAuditEntryIndex()
      if (this.hasUnpublishedRows()) {
        await this.ensureAlarm()
      }
    })
  }

  public async exists(idempotencyKeys: string[]): Promise<string[]> {
    await this.ready

    if (idempotencyKeys.length === 0) {
      return []
    }

    const uniqueKeys = unique(idempotencyKeys)
    const index = this.getAuditEntryIndex()
    const result = uniqueKeys.filter((key) => index.has(key))

    return result
  }

  public async commit(entries: LedgerEntry[]): Promise<CommitResult> {
    await this.ready

    if (entries.length === 0) {
      return { inserted: 0, duplicates: 0, conflicts: 0 }
    }

    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "ingestionaudit",
        operation: "commit",
        waitUntil: (p) => this.ctx.waitUntil(p),
        baseFields: { entry_count: entries.length },
      },
      async () => this.commitInner(entries)
    )
  }

  private async commitInner(entries: LedgerEntry[]): Promise<CommitResult> {
    let inserted = 0
    let duplicates = 0
    let conflicts = 0

    const index = this.getAuditEntryIndex()
    const pendingPayloadHashesByKey = new Map<string, string>()
    const entriesToInsert: LedgerEntry[] = []

    for (const entry of entries) {
      const existingPayloadHash =
        pendingPayloadHashesByKey.get(entry.idempotencyKey) ??
        index.get(entry.idempotencyKey)?.payloadHash

      if (existingPayloadHash !== undefined) {
        if (existingPayloadHash === entry.payloadHash) {
          duplicates++
        } else {
          conflicts++
        }
        continue
      }

      entriesToInsert.push(entry)
      pendingPayloadHashesByKey.set(entry.idempotencyKey, entry.payloadHash)
      inserted++
    }

    if (entriesToInsert.length > 0) {
      // One durable audit batch is both the dedupe record and the publish intent.
      // Keep this write synchronous before scheduling the alarm.
      this.db
        .insert(ingestionAuditBatchesTable)
        .values({
          firstSeenAt: Math.min(...entriesToInsert.map((entry) => entry.firstSeenAt)),
          createdAt: Date.now(),
          entriesJson: JSON.stringify(entriesToInsert),
          publishedAt: null,
        })
        .run()

      for (const entry of entriesToInsert) {
        index.set(entry.idempotencyKey, { payloadHash: entry.payloadHash })
      }
    }

    if (inserted > 0) {
      await this.ensureAlarm()
    }

    this.logger.set({ inserted, duplicates, conflicts })
    this.logger.info("ingestion audit commit", { inserted, duplicates, conflicts })
    return { inserted, duplicates, conflicts }
  }

  async alarm(): Promise<void> {
    await this.ready
    this.alarmScheduled = false

    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "ingestionaudit",
        operation: "alarm",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => this.alarmInner()
    )
  }

  private async alarmInner(): Promise<void> {
    const published = await this.publishUnpublishedRows()
    this.cleanupExpiredRows()
    this.checkStuckRows()

    const remaining = this.hasUnpublishedRows() ? 1 : 0
    this.logger.set({ published, unpublished_remaining: remaining })

    if (remaining > 0) {
      if (published) {
        await this.ensureAlarm()
      } else {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_DELAY_MS)
      }
    }

    this.logger.info("ingestion audit alarm", { published, unpublished_remaining: remaining })
  }

  private async publishUnpublishedRows(): Promise<boolean> {
    const batchRows = this.db
      .select({
        id: ingestionAuditBatchesTable.id,
        entriesJson: ingestionAuditBatchesTable.entriesJson,
      })
      .from(ingestionAuditBatchesTable)
      .where(isNull(ingestionAuditBatchesTable.publishedAt))
      .orderBy(asc(ingestionAuditBatchesTable.firstSeenAt))
      .limit(OUTBOX_BATCH_SIZE)
      .all()

    if (batchRows.length === 0) {
      return true
    }

    try {
      const events = batchRows.flatMap((row) =>
        this.parseLedgerEntries(row.entriesJson, { strict: true }).map((entry): PipelineRecord => {
          const payload = JSON.parse(entry.auditPayloadJson)
          return parseLakehouseEvent("events", payload) as PipelineRecord
        })
      )

      await this.publishEvents(events)

      const now = Date.now()
      const ids = batchRows.map((row) => row.id)
      if (ids.length > 0) {
        for (let i = 0; i < ids.length; i += AUDIT_PUBLISH_UPDATE_BATCH_SIZE) {
          const batch = ids.slice(i, i + AUDIT_PUBLISH_UPDATE_BATCH_SIZE)
          this.db
            .update(ingestionAuditBatchesTable)
            .set({
              publishedAt: now,
            })
            .where(inArray(ingestionAuditBatchesTable.id, batch))
            .run()
        }
      }

      return true
    } catch {
      return false
    }
  }

  private async publishEvents(events: PipelineRecord[]): Promise<void> {
    const localPipelineUrl = this.resolveLocalPipelineUrl()

    if (localPipelineUrl) {
      await this.sendToLocalPipeline(localPipelineUrl, events)
      return
    }

    if (!this.pipelineEvents) {
      throw new Error("PIPELINE_EVENTS binding is required when LOCAL_PIPELINE_URL is not set")
    }

    await this.pipelineEvents.send(events)
  }

  private resolveLocalPipelineUrl(): string | null {
    if (this.appEnv && this.appEnv !== "development") {
      return null
    }

    return this.localPipelineUrl && this.localPipelineUrl.length > 0 ? this.localPipelineUrl : null
  }

  private async sendToLocalPipeline(url: string, events: PipelineRecord[]): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(events),
    })

    if (!response.ok) {
      throw new Error(`local pipeline sink failed with status ${response.status}`)
    }
  }

  private cleanupExpiredRows(): void {
    const cutoff = Date.now() - AUDIT_RETENTION_MS

    // Drizzle doesn't expose a straightforward SQLite DELETE ... LIMIT helper.
    // Keep this as raw SQL to preserve the bounded cleanup behavior.
    this.ctx.storage.sql.exec(
      `
        DELETE FROM ${BATCH_TABLE_NAME}
        WHERE id IN (
          SELECT id
          FROM ${BATCH_TABLE_NAME}
          WHERE published_at IS NOT NULL
            AND first_seen_at < ?
          ORDER BY first_seen_at
          LIMIT ?
        )
      `,
      cutoff,
      RETENTION_CLEANUP_BATCH_SIZE
    )
    this.auditEntryIndex = null
  }

  private checkStuckRows(): void {
    const threshold = Date.now() - STUCK_ROW_THRESHOLD_MS

    const stuckBatch = this.db
      .select({ id: ingestionAuditBatchesTable.id })
      .from(ingestionAuditBatchesTable)
      .where(
        and(
          isNull(ingestionAuditBatchesTable.publishedAt),
          lt(ingestionAuditBatchesTable.firstSeenAt, threshold)
        )
      )
      .orderBy(asc(ingestionAuditBatchesTable.firstSeenAt))
      .limit(1)
      .get()

    if (stuckBatch) {
      this.logger.warn("audit batch rows unpublished for > 10 minutes", {
        batch_id: stuckBatch.id,
      })
    }
  }

  private hasUnpublishedRows(): boolean {
    const batchRow = this.db
      .select({ id: ingestionAuditBatchesTable.id })
      .from(ingestionAuditBatchesTable)
      .where(isNull(ingestionAuditBatchesTable.publishedAt))
      .orderBy(asc(ingestionAuditBatchesTable.firstSeenAt))
      .limit(1)
      .get()

    return Boolean(batchRow)
  }

  private async ensureAlarm(): Promise<void> {
    if (this.alarmScheduled) {
      return
    }

    const current = await this.ctx.storage.getAlarm()
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000)
    }
    this.alarmScheduled = true
  }

  private getAuditEntryIndex(): Map<string, AuditEntryIndexValue> {
    if (!this.auditEntryIndex) {
      this.hydrateAuditEntryIndex()
    }

    return this.auditEntryIndex!
  }

  private hydrateAuditEntryIndex(): void {
    const index = new Map<string, AuditEntryIndexValue>()

    const batchRows = this.db
      .select({
        entriesJson: ingestionAuditBatchesTable.entriesJson,
      })
      .from(ingestionAuditBatchesTable)
      .all()

    for (const row of batchRows) {
      for (const entry of this.parseLedgerEntries(row.entriesJson)) {
        index.set(entry.idempotencyKey, { payloadHash: entry.payloadHash })
      }
    }

    this.auditEntryIndex = index
  }

  private parseLedgerEntries(
    entriesJson: string,
    options: { strict?: boolean } = {}
  ): LedgerEntry[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(entriesJson)
    } catch (error) {
      if (options.strict) {
        throw error
      }
      this.logger.warn("failed to parse ingestion audit batch entries", {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    if (!Array.isArray(parsed)) {
      if (options.strict) {
        throw new Error("ingestion audit batch entries were not an array")
      }
      this.logger.warn("ingestion audit batch entries were not an array")
      return []
    }

    const entries: LedgerEntry[] = []
    for (const value of parsed) {
      if (isLedgerEntry(value)) {
        entries.push(value)
      }
    }

    if (options.strict && entries.length !== parsed.length) {
      throw new Error("ingestion audit batch entries contained malformed entries")
    }

    return entries
  }
}
