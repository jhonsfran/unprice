import { sql } from "drizzle-orm"
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
  operationsJson: text("operations_json")
    .notNull()
    .default('{"upsert":0,"authorize":0,"settle":0,"release":0,"charge":0,"record":0}'),
})

export const budgetOperations = sqliteTable(
  "budget_operations",
  {
    /** `h_<n>` for a hold; `o:<key_hash>` for a charge or record; `l:<key_hash>` for a lease. */
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["hold", "charge", "record", "lease"] }).notNull(),
    status: text("status", { enum: ["open", "settled", "released", "done"] }).notNull(),
    /**
     * When the alarm next visits the row (`alarmAt`): an open hold's or lease's expiry, else
     * retention end.
     */
    dueAt: integer("due_at").notNull(),
    /** The operation without `kind` and `id`, with tagged bigints. */
    dataJson: text("data_json").notNull(),
  },
  (table) => ({
    due: index("budget_operations_due_idx").on(table.dueAt),
    // Only holds: a charge or record is found by its id, the key's hash, so indexing its key too
    // would cost a row write on every one.
    holdKey: uniqueIndex("budget_operations_hold_key_idx")
      .on(sql`data_json ->> '$.idempotencyKey'`)
      .where(sql`kind = 'hold'`),
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
