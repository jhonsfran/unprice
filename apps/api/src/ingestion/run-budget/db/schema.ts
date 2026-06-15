import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const runState = sqliteTable("run_state", {
  runId: text("run_id").primaryKey(),
  projectId: text("project_id").notNull(),
  customerId: text("customer_id").notNull(),
  agentId: text("agent_id").notNull(),
  reservationId: text("reservation_id"),
  status: text("status").notNull(),
  currency: text("currency").notNull(),
  budgetAmount: integer("budget_amount").notNull(),
  reservedAmount: integer("reserved_amount").notNull().default(0),
  consumedAmount: integer("consumed_amount").notNull().default(0),
  flushedAmount: integer("flushed_amount").notNull().default(0),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  expiresAt: integer("expires_at"),
  lastEventAt: integer("last_event_at"),
  traceId: text("trace_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
})

export const runSpendBuckets = sqliteTable(
  "run_spend_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    runId: text("run_id").notNull(),
    entitlementId: text("entitlement_id").notNull(),
    featureId: text("feature_id"),
    statementKey: text("statement_key").notNull(),
    periodStartAt: integer("period_start_at").notNull(),
    periodEndAt: integer("period_end_at").notNull(),
    currency: text("currency").notNull(),
    consumedAmount: integer("consumed_amount").notNull().default(0),
    flushedAmount: integer("flushed_amount").notNull().default(0),
    pendingAmount: integer("pending_amount").notNull().default(0),
  },
  (table) => ({
    run: uniqueIndex("run_spend_buckets_run_bucket_idx").on(table.runId, table.bucketKey),
  })
)

export const runCaptureIntents = sqliteTable("run_capture_intents", {
  intentKey: text("intent_key").primaryKey(),
  runId: text("run_id").notNull(),
  bucketKey: text("bucket_key").notNull(),
  amount: integer("amount").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const runIdempotency = sqliteTable("run_idempotency", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  runId: text("run_id").notNull(),
  decisionJson: text("decision_json").notNull(),
  pricedAmount: integer("priced_amount").notNull().default(0),
  bucketDeltasJson: text("bucket_deltas_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
})
