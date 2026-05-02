import type { ConfigFeatureVersionType, OverageStrategy, ResetConfig } from "@unprice/db/validators"
import type { MeterConfig } from "@unprice/services/entitlements"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const meterFactsOutboxTable = sqliteTable("meter_facts_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  currency: text("currency").notNull(),
})

export const idempotencyKeysTable = sqliteTable("idempotency_keys", {
  eventId: text("event_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  allowed: integer("allowed", { mode: "boolean" }).notNull(),
  deniedReason: text("denied_reason"),
  denyMessage: text("deny_message"),
})

export const grantsTable = sqliteTable("grants", {
  grantId: text("grant_id").primaryKey(),
  amount: real("amount"),
  anchor: integer("anchor").notNull(),
  currencyCode: text("currency_code").notNull(),
  effectiveAt: integer("effective_at").notNull(),
  expiresAt: integer("expires_at"),
  featureConfig: text("feature_config", { mode: "json" })
    .$type<ConfigFeatureVersionType>()
    .notNull(),
  featurePlanVersionId: text("feature_plan_version_id").notNull(),
  featureSlug: text("feature_slug").notNull(),
  meterConfig: text("meter_config", { mode: "json" }).$type<MeterConfig>().notNull(),
  meterHash: text("meter_hash").notNull(),
  overageStrategy: text("overage_strategy").$type<OverageStrategy>().notNull(),
  priority: integer("priority").notNull(),
  resetConfig: text("reset_config", { mode: "json" }).$type<ResetConfig | null>(),
  addedAt: integer("added_at").notNull(),
})

export const grantWindowsTable = sqliteTable("grant_windows", {
  bucketKey: text("bucket_key").primaryKey(),
  grantId: text("grant_id").notNull(),
  periodKey: text("period_key").notNull(),
  periodStartAt: integer("period_start_at").notNull(),
  periodEndAt: integer("period_end_at").notNull(),
  consumedInCurrentWindow: real("consumed_in_current_window").notNull().default(0),
  exhaustedAt: integer("exhausted_at"),
})

// Raw aggregation state for the meter engine. This is not entitlement usage
// and it has no cadence reset; grant_windows is the source of truth for
// entitlement-period consumption.
export const meterStateTable = sqliteTable("meter_state", {
  meterKey: text("meter_key").primaryKey(),
  usage: real("usage").notNull().default(0),
  updatedAt: integer("updated_at"),
  createdAt: integer("created_at").notNull(),
})

// Singleton reservation state for this DO. This mirrors the allocation that
// WalletService.createReservation / flushReservation have moved into
// customer.{cid}.reserved so the hot path can answer "can this event be
// funded?" without touching the ledger per event. All amounts are pgledger
// scale-8 minor units ($1 = 100_000_000).
export const walletReservationTable = sqliteTable("wallet_reservation", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  customerId: text("customer_id"),
  currency: text("currency").notNull(),
  reservationEndAt: integer("reservation_end_at"),

  reservationId: text("reservation_id"),
  allocationAmount: integer("allocation_amount").notNull().default(0),
  consumedAmount: integer("consumed_amount").notNull().default(0),
  flushedAmount: integer("flushed_amount").notNull().default(0),
  refillThresholdBps: integer("refill_threshold_bps").notNull().default(2000),
  refillChunkAmount: integer("refill_chunk_amount").notNull().default(0),
  refillInFlight: integer("refill_in_flight", { mode: "boolean" }).notNull().default(false),
  flushSeq: integer("flush_seq").notNull().default(0),
  pendingFlushSeq: integer("pending_flush_seq"),
  lastEventAt: integer("last_event_at"),
  deletionRequested: integer("deletion_requested", { mode: "boolean" }).notNull().default(false),
  recoveryRequired: integer("recovery_required", { mode: "boolean" }).notNull().default(false),
  lastFlushedAt: integer("last_flushed_at"),
})

export const schema = {
  meterFactsOutboxTable,
  idempotencyKeysTable,
  grantsTable,
  grantWindowsTable,
  meterStateTable,
  walletReservationTable,
}

export type SchemaIngestion = typeof schema
