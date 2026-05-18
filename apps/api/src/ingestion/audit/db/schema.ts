import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ingestionAuditTable = sqliteTable(
  "ingestion_audit",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    canonicalAuditId: text("canonical_audit_id").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").$type<"processed" | "rejected">().notNull(),
    rejectionReason: text("rejection_reason"),
    resultJson: text("result_json"),
    auditPayloadJson: text("audit_payload_json").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => ({
    unpublishedIdx: index("idx_ingestion_audit_unpublished")
      .on(table.firstSeenAt)
      .where(sql`${table.publishedAt} IS NULL`),
    publishedRetentionIdx: index("idx_ingestion_audit_published_retention")
      .on(table.firstSeenAt)
      .where(sql`${table.publishedAt} IS NOT NULL`),
  })
)

export const schema = {
  ingestionAuditTable,
}

export type SchemaIngestionAudit = typeof schema
