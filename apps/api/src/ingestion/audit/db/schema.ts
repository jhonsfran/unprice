import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ingestionAuditBatchesTable = sqliteTable(
  "ingestion_audit_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    firstSeenAt: integer("first_seen_at").notNull(),
    createdAt: integer("created_at").notNull(),
    entriesJson: text("entries_json").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => ({
    unpublishedIdx: index("idx_ingestion_audit_batches_unpublished")
      .on(table.firstSeenAt)
      .where(sql`${table.publishedAt} IS NULL`),
    publishedRetentionIdx: index("idx_ingestion_audit_batches_published_retention")
      .on(table.firstSeenAt)
      .where(sql`${table.publishedAt} IS NOT NULL`),
  })
)

export const schema = {
  ingestionAuditBatchesTable,
}

export type SchemaIngestionAudit = typeof schema
