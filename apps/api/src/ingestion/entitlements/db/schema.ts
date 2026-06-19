import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const idempotencyKeyBatchesTable = sqliteTable(
  "idempotency_key_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at").notNull(),
    entries: text("entries").notNull(),
  },
  (table) => ({
    createdAtIdx: index("idx_idempotency_key_batches_created_at").on(table.createdAt),
  })
)

export const entitlementPeriodUsageTable = sqliteTable(
  "entitlement_period_usage",
  {
    periodKey: text("period_key").primaryKey(),
    periodStartAt: integer("period_start_at").notNull(),
    periodEndAt: integer("period_end_at").notNull(),
    grantStatesJson: text("grant_states_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    periodEndAtIdx: index("idx_entitlement_period_usage_period_end_at").on(table.periodEndAt),
  })
)

// Raw aggregation state for the meter engine. This is not entitlement usage
// and it has no cadence reset; entitlement_period_usage is the source of
// truth for entitlement-period consumption.
export const meterStateTable = sqliteTable("meter_state", {
  meterKey: text("meter_key").primaryKey(),
  usage: real("usage").notNull().default(0),
  updatedAt: integer("updated_at"),
  createdAt: integer("created_at").notNull(),
})

// Singleton reservation state for this DO. This mirrors the allocation that
// WalletService.createReservation plus capture/extend/release have moved into
// customer.{cid}.reserved so the hot path can answer "can this event be
// funded?" without touching the ledger per event. All amounts are pgledger
// scale-8 minor units ($1 = 100_000_000).
export const walletReservationTable = sqliteTable("wallet_reservation", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  customerId: text("customer_id"),
  currency: text("currency").notNull(),
  reservationEndAt: integer("reservation_end_at"),
  billingPeriodId: text("billing_period_id"),
  cycleEndAt: integer("cycle_end_at"),
  cycleStartAt: integer("cycle_start_at"),
  featurePlanVersionItemId: text("feature_plan_version_item_id"),
  featureSlug: text("feature_slug"),
  statementKey: text("statement_key"),

  reservationId: text("reservation_id"),
  allocationAmount: integer("allocation_amount").notNull().default(0),
  consumedAmount: integer("consumed_amount").notNull().default(0),
  flushedAmount: integer("flushed_amount").notNull().default(0),
  consumedQuantity: real("consumed_quantity").notNull().default(0),
  flushedQuantity: real("flushed_quantity").notNull().default(0),
  refillThresholdBps: integer("refill_threshold_bps").notNull().default(2000),
  refillChunkAmount: integer("refill_chunk_amount").notNull().default(0),
  targetReservationAmount: integer("target_reservation_amount").notNull().default(0),
  spendEwmaAmount: integer("spend_ewma_amount").notNull().default(0),
  lastRateSampledAtMs: integer("last_rate_sampled_at_ms"),
  maxEventCostAmount: integer("max_event_cost_amount").notNull().default(0),
  pendingRefillAmount: integer("pending_refill_amount").notNull().default(0),
  pendingFlushAmount: integer("pending_flush_amount"),
  pendingFlushQuantity: real("pending_flush_quantity"),
  refillInFlight: integer("refill_in_flight", { mode: "boolean" }).notNull().default(false),
  flushSeq: integer("flush_seq").notNull().default(0),
  pendingFlushSeq: integer("pending_flush_seq"),
  pendingFlushFinal: integer("pending_flush_final", { mode: "boolean" }).notNull().default(false),
  lastEventAt: integer("last_event_at"),
  deletionRequested: integer("deletion_requested", { mode: "boolean" }).notNull().default(false),
  recoveryRequired: integer("recovery_required", { mode: "boolean" }).notNull().default(false),
  lastFlushedAt: integer("last_flushed_at"),
})

export const schema = {
  idempotencyKeyBatchesTable,
  entitlementPeriodUsageTable,
  meterStateTable,
  walletReservationTable,
}

export type SchemaIngestion = typeof schema
