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
  lastAt: integer("last_at").notNull(),
  holdSeq: integer("hold_seq").notNull(),
  held: amount("held").notNull(),
  usageJson: text("usage_json").notNull(),
})

/**
 * Holds, charges, and records. The row is the open hold, the closed tombstone, and the idempotency
 * record at once. `due_at` is `dueAt(operation)`: lapse time for open holds, the end of retention
 * for everything else.
 */
export const budgetOperations = sqliteTable(
  "budget_operations",
  {
    /** `h_<n>` for a hold; `o:<key_hash>` for a charge or record. */
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
 * One row per ended period of a limited window that had usage. The commit that inserts a period
 * deletes that window's periods beyond WINDOW_HISTORY_PERIODS, the most `get` returns.
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
