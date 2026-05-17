import type { Pipeline, PipelineRecord } from "cloudflare:pipelines"
import { DurableObject } from "cloudflare:workers"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import type { AppLogger } from "@unprice/observability"
import { DO_IDEMPOTENCY_TTL_MS } from "@unprice/services/entitlements"
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { createDoLogger, runDoOperation } from "~/observability"
import { ingestionAuditTable, schema } from "./db/schema"
import migrations from "./drizzle/migrations"

const TABLE_NAME = "ingestion_audit"

const AUDIT_RETENTION_MS = DO_IDEMPOTENCY_TTL_MS
const OUTBOX_BATCH_SIZE = 500 // 500 rows
const RETENTION_CLEANUP_BATCH_SIZE = 5000 // 5000 rows
const ALARM_RETRY_DELAY_MS = 30_000 // 30 seconds
const STUCK_ROW_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

type LedgerEntry = {
  auditPayloadJson: string
  canonicalAuditId: string
  firstSeenAt: number
  idempotencyKey: string
  payloadHash: string
  rejectionReason?: string
  resultJson: string
  status: "processed" | "rejected"
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
  private readonly logger: AppLogger
  private alarmScheduled = false

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
    })
  }

  public async exists(idempotencyKeys: string[]): Promise<string[]> {
    await this.ready

    if (idempotencyKeys.length === 0) {
      return []
    }

    const rows = this.db
      .select({ idempotencyKey: ingestionAuditTable.idempotencyKey })
      .from(ingestionAuditTable)
      .where(inArray(ingestionAuditTable.idempotencyKey, idempotencyKeys))
      .all()

    return rows.map((r) => r.idempotencyKey)
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

    for (const entry of entries) {
      const existing = this.db
        .select({ payloadHash: ingestionAuditTable.payloadHash })
        .from(ingestionAuditTable)
        .where(eq(ingestionAuditTable.idempotencyKey, entry.idempotencyKey))
        .get()

      if (existing) {
        if (existing.payloadHash === entry.payloadHash) {
          duplicates++
        } else {
          conflicts++
        }
        continue
      }

      this.db
        .insert(ingestionAuditTable)
        .values({
          idempotencyKey: entry.idempotencyKey,
          canonicalAuditId: entry.canonicalAuditId,
          payloadHash: entry.payloadHash,
          status: entry.status,
          rejectionReason: entry.rejectionReason ?? null,
          resultJson: entry.resultJson,
          auditPayloadJson: entry.auditPayloadJson,
          firstSeenAt: entry.firstSeenAt,
          publishedAt: null,
        })
        .onConflictDoNothing({
          target: ingestionAuditTable.idempotencyKey,
        })
        .run()

      inserted++
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
    const rows = this.db
      .select({
        idempotencyKey: ingestionAuditTable.idempotencyKey,
        canonicalAuditId: ingestionAuditTable.canonicalAuditId,
        auditPayloadJson: ingestionAuditTable.auditPayloadJson,
        firstSeenAt: ingestionAuditTable.firstSeenAt,
      })
      .from(ingestionAuditTable)
      .where(isNull(ingestionAuditTable.publishedAt))
      .orderBy(asc(ingestionAuditTable.firstSeenAt))
      .limit(OUTBOX_BATCH_SIZE)
      .all()

    if (rows.length === 0) {
      return true
    }

    try {
      const events = rows.map((row): PipelineRecord => {
        const payload = JSON.parse(row.auditPayloadJson)
        return parseLakehouseEvent("events", payload) as PipelineRecord
      })

      await this.publishEvents(events)

      const now = Date.now()
      for (const row of rows) {
        this.db
          .update(ingestionAuditTable)
          .set({
            publishedAt: now,
          })
          .where(eq(ingestionAuditTable.idempotencyKey, row.idempotencyKey))
          .run()
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
        DELETE FROM ${TABLE_NAME}
        WHERE idempotency_key IN (
          SELECT idempotency_key
          FROM ${TABLE_NAME}
          WHERE published_at IS NOT NULL
            AND first_seen_at < ?
          ORDER BY first_seen_at
          LIMIT ?
        )
      `,
      cutoff,
      RETENTION_CLEANUP_BATCH_SIZE
    )
  }

  private checkStuckRows(): void {
    const threshold = Date.now() - STUCK_ROW_THRESHOLD_MS

    const stuck = this.db
      .select({ idempotencyKey: ingestionAuditTable.idempotencyKey })
      .from(ingestionAuditTable)
      .where(
        and(isNull(ingestionAuditTable.publishedAt), lt(ingestionAuditTable.firstSeenAt, threshold))
      )
      .orderBy(asc(ingestionAuditTable.firstSeenAt))
      .limit(1)
      .get()

    if (stuck) {
      this.logger.warn("audit rows unpublished for > 10 minutes", {
        idempotency_key: stuck.idempotencyKey,
      })
    }
  }

  private hasUnpublishedRows(): boolean {
    const row = this.db
      .select({ idempotencyKey: ingestionAuditTable.idempotencyKey })
      .from(ingestionAuditTable)
      .where(isNull(ingestionAuditTable.publishedAt))
      .orderBy(asc(ingestionAuditTable.firstSeenAt))
      .limit(1)
      .get()

    return Boolean(row)
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
}
