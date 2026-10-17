import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

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

/**
 * Append-only audit trail of every fact. `seq` and `at` grow together, so pruning walks the
 * primary key. The ledger row, not this table, is the balance.
 */
export const budgetEntries = sqliteTable("budget_entries", {
  seq: integer("seq").primaryKey(),
  at: integer("at").notNull(),
  type: text("type").notNull(),
  factJson: text("fact_json").notNull(),
})

/**
 * Holds, charges, and records. The row is the open hold, the closed tombstone,
 * and the idempotency record at once. `due_at` is `dueAt(operation)`: lapse time for open holds,
 * purge time for everything else.
 */
export const budgetOperations = sqliteTable(
  "budget_operations",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["hold", "charge", "record"] }).notNull(),
    status: text("status", {
      enum: ["open", "lapsed", "settled", "released", "done"],
    }).notNull(),
    /** sha256 of the idempotency key. */
    keyHash: text("key_hash").notNull(),
    dueAt: integer("due_at").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => ({
    due: index("budget_operations_due_at_idx").on(table.dueAt),
    key: uniqueIndex("budget_operations_key_hash_idx").on(table.keyHash),
  })
)

/**
 * One row per `window.rolled` fact: a period of a window that ended with usage. The commit that
 * inserts a period deletes that window's periods beyond WINDOW_HISTORY_PERIODS, the most `get`
 * returns.
 */
export const budgetWindowHistory = sqliteTable(
  "budget_window_history",
  {
    windowId: text("window_id").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    consumed: amount("consumed").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.windowId, table.start] }) })
)

/**
 * What every `recorded` fact leaves for RECORD_DEDUPE_MS, keyed by the sha256 of its idempotency
 * key: it outlives the record's operation row, so for 8 days a replay answers as the row did and a
 * changed request under the same key is a conflict.
 */
export const budgetRecordReceipts = sqliteTable(
  "budget_record_receipts",
  {
    keyHash: text("key_hash").primaryKey(),
    requestHash: text("request_hash").notNull(),
    amount: amount("amount").notNull(),
    crossedJson: text("crossed_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => ({ expires: index("budget_record_receipts_expires_at_idx").on(table.expiresAt) })
)
