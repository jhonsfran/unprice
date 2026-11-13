import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// DO SQLite cannot bind bigint, and the store never sums in SQL, so a usage vector (the amount
// and a quantity per feature) is JSON with tagged bigints in a TEXT column.

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
  /** What open holds and leases reserve, a usage vector. */
  heldJson: text("held").notNull(),
  usageJson: text("usage_json").notNull(),
  operationsJson: text("operations_json")
    .notNull()
    .default('{"upsert":0,"authorize":0,"settle":0,"release":0,"charge":0,"record":0}'),
  /** The last `seq` given to a written operation row. */
  journalSeq: integer("journal_seq").notNull().default(0),
  /** Every row with `seq <= exported_seq` reached the journal stream; only those may be purged. */
  exportedSeq: integer("exported_seq").notNull().default(0),
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
    /** Per-budget write sequence: every write of the row takes the next one (ADR-0008 D7). */
    seq: integer("seq").notNull().default(0),
    /** When this version of the row was written. */
    writtenAt: integer("written_at").notNull().default(0),
  },
  (table) => ({
    inspection: index("budget_operations_inspection_idx").on(table.dueAt, table.id),
    journal: index("budget_operations_journal_idx").on(table.seq),
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
    /** The period's usage vector. */
    consumedJson: text("consumed").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.windowId, table.start] }) })
)

/**
 * One billing period of one feature. Totals are a
 * tagged-bigint JSON object (`quantity`, `amount`, `cost`); positions live in `budget_positions`.
 */
export const budgetStatements = sqliteTable(
  "budget_statements",
  {
    periodId: text("period_id").primaryKey(),
    statementKey: text("statement_key").notNull(),
    featureSlug: text("feature_slug").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    /** Billing waives the period's usage (a trial): a prepaid close captures none of it. */
    free: integer("free", { mode: "boolean" }).notNull().default(false),
    state: text("state", { enum: ["open", "sealed", "completed"] }).notNull(),
    registeredAt: integer("registered_at").notNull(),
    sealedAt: integer("sealed_at"),
    completedAt: integer("completed_at"),
    totalsJson: text("totals_json").notNull(),
    events: integer("events").notNull(),
    lastEventAt: integer("last_event_at"),
  },
  (table) => ({
    feature: index("budget_statements_feature_idx").on(table.featureSlug, table.end),
    key: index("budget_statements_key_idx").on(table.statementKey, table.end),
  })
)

/**
 * A pricing position of a statement: one row per line an event moved, so an event writes the
 * positions it moved, not every position of its statement. The value is a decimal of scale 8.
 */
export const budgetPositions = sqliteTable(
  "budget_positions",
  {
    periodId: text("period_id").notNull(),
    positionKey: text("position_key").notNull(),
    value: text("value").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.periodId, table.positionKey] }) })
)

/** The rate cards the budget's pricing names, as last read from the card source. */
export const budgetCards = sqliteTable("budget_cards", {
  cardId: text("card_id").primaryKey(),
  /** The card and its rows, tagged-bigint JSON. */
  cardJson: text("card_json").notNull(),
  refreshedAt: integer("refreshed_at").notNull(),
})

/**
 * A prepaid budget's wallet reservation for one statement key (ADR-0008 D10): its allocation, what
 * the key consumed, the last applied `seq`, and the intent pending against the wallet. The row is
 * tagged-bigint JSON; `state` is a column so the alarm can ask whether any reservation is open.
 */
export const budgetFunding = sqliteTable("budget_funding", {
  statementKey: text("statement_key").primaryKey(),
  state: text("state", { enum: ["open", "closed"] }).notNull(),
  dataJson: text("data_json").notNull(),
})

/**
 * Rows a command deleted to reuse their key before the journal received them. The export reads
 * them beside `budget_operations`, so a key reused past its retention never leaves a hole.
 */
export const budgetJournalBacklog = sqliteTable("budget_journal_backlog", {
  seq: integer("seq").primaryKey(),
  /** The deleted row's stored id. */
  storedId: text("stored_id").notNull(),
  kind: text("kind", { enum: ["hold", "charge", "record", "lease"] }).notNull(),
  status: text("status", { enum: ["open", "settled", "released", "done"] }).notNull(),
  dataJson: text("data_json").notNull(),
  writtenAt: integer("written_at").notNull(),
})
