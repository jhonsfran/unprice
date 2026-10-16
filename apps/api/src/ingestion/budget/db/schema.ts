import { customType, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** DO SQLite cannot bind bigint, and the store never sums in SQL, so amounts are TEXT. */
const amount = customType<{ data: bigint; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toString(),
  fromDriver: (value) => BigInt(value),
})

/** Singleton row (id = 1); absent until the first upsert. */
export const budgetRecord = sqliteTable("budget", {
  id: integer("id").primaryKey(),
  key: text("key").notNull(),
  projectId: text("project_id").notNull(),
  unit: text("unit").notNull(),
  version: integer("version").notNull(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

/** Singleton row (id = 1): the aggregate every accepted command rewrites. */
export const budgetLedger = sqliteTable("budget_ledger", {
  id: integer("id").primaryKey(),
  seq: integer("seq").notNull(),
  lastAt: integer("last_at").notNull(),
  holdSeq: integer("hold_seq").notNull(),
  held: amount("held").notNull(),
  usageJson: text("usage_json").notNull(),
})

/** Singleton row (id = 1): the ledger folded through `seq` from compacted entries. */
export const budgetJournalBase = sqliteTable("budget_journal_base", {
  id: integer("id").primaryKey(),
  seq: integer("seq").notNull(),
  ledgerJson: text("ledger_json").notNull(),
})

/** Append-only journal. `seq` and `at` grow together, so compaction walks the primary key. */
export const budgetEntries = sqliteTable("budget_entries", {
  seq: integer("seq").primaryKey(),
  at: integer("at").notNull(),
  type: text("type").notNull(),
  factJson: text("fact_json").notNull(),
})

/**
 * Holds, charges, records, and late settlements. The row is the open hold, the closed tombstone,
 * and the idempotency record at once. `due_at` is `dueAt(operation)`: lapse time for open holds,
 * purge time for everything else.
 */
export const budgetOperations = sqliteTable(
  "budget_operations",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["hold", "charge", "record", "late_settle"] }).notNull(),
    status: text("status", {
      enum: ["open", "lapsed", "settled", "released", "done"],
    }).notNull(),
    /** sha256 of the idempotency key; null for late settlements, which are keyed by hold id. */
    keyHash: text("key_hash"),
    dueAt: integer("due_at").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => ({
    due: index("budget_operations_due_at_idx").on(table.dueAt),
    key: uniqueIndex("budget_operations_key_hash_idx").on(table.keyHash),
  })
)
