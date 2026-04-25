import type { ConfigFeatureVersionType } from "@unprice/db/validators"
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

// Singleton row per DO (one meter per EntitlementWindowDO). Holds the
// snapshotted pricing + period boundary *and* the engine's running state
// (usage, updatedAt). Replaces the prior `meter_pricing` + `meter_state`
// split now that a DO only ever tracks one meter.
//
// The reservation columns (Phase 7) mirror — in the DO's local SQLite — the
// allocation that `WalletService.createReservation` / `flushReservation`
// have moved into `customer.{cid}.reserved`. They exist so the hot path
// can answer "can this event be funded?" without touching the ledger per
// event. All amounts are pgledger scale-8 minor units (`$1 = 100_000_000`).
export const meterWindowTable = sqliteTable("meter_window", {
  meterKey: text("meter_key").primaryKey(),
  currency: text("currency").notNull(),
  priceConfig: text("price_config", { mode: "json" }).$type<ConfigFeatureVersionType>().notNull(),
  periodEndAt: integer("period_end_at"),
  usage: real("usage").notNull().default(0),
  updatedAt: integer("updated_at"),
  createdAt: integer("created_at").notNull(),

  // Customer / project identity (Phase 7). Seeded from the first apply() —
  // the DO already receives these on every call, we persist them so the
  // wallet flush path (and alarm() in 7.7) can issue a ledger call without
  // carrying apply's input forward.
  projectId: text("project_id"),
  customerId: text("customer_id"),

  // Reservation state (Phase 7).
  reservationId: text("reservation_id"),
  // Total money moved into `customer.{cid}.reserved` for this window.
  allocationAmount: integer("allocation_amount").notNull().default(0),
  // Cumulative money burned — incremented on every allowed apply().
  consumedAmount: integer("consumed_amount").notNull().default(0),
  // Cumulative amount the DO has successfully flushed to the ledger.
  // `consumedAmount - flushedAmount` is the next flush leg size.
  flushedAmount: integer("flushed_amount").notNull().default(0),
  // Refill trigger: when `allocation - consumed < threshold`, request a refill.
  refillThresholdBps: integer("refill_threshold_bps").notNull().default(2000),
  refillChunkAmount: integer("refill_chunk_amount").notNull().default(0),
  // Single-flight guard: prevents duplicate `ctx.waitUntil` refills.
  refillInFlight: integer("refill_in_flight", { mode: "boolean" }).notNull().default(false),
  // Idempotency sequence for flush+refill. Incremented at request time,
  // persisted with the result so crashed flushes can be replayed.
  flushSeq: integer("flush_seq").notNull().default(0),
  pendingFlushSeq: integer("pending_flush_seq"),

  // Alarm-driven final flush (Phase 7.7). Any of three triggers
  // converges on `finalFlush`: period end, 24h inactivity, or a caller-
  // initiated deletion.
  //
  // `last_event_at` is stamped by apply() on every successful commit so
  // alarm() can detect the inactivity window without an extra query.
  // `deletion_requested` is flipped by `requestDeletion()` RPC; alarm()
  // drains the reservation and then nukes storage.
  // `recovery_required` is a terminal guard: if finalFlush fails in a way
  // that shouldn't be auto-retried, alarm() keeps scheduling itself but
  // skips the flush until an operator intervenes.
  lastEventAt: integer("last_event_at"),
  deletionRequested: integer("deletion_requested", { mode: "boolean" }).notNull().default(false),
  recoveryRequired: integer("recovery_required", { mode: "boolean" }).notNull().default(false),

  // Timestamp of the last successful (final or non-final) flush. Used by
  // alarm() to enforce a maximum interval between ledger updates so cold
  // meters — those that never cross the refill threshold — still surface
  // their consumption to the wallet on a predictable cadence.
  lastFlushedAt: integer("last_flushed_at"),
})

export const schema = {
  meterFactsOutboxTable,
  idempotencyKeysTable,
  meterWindowTable,
}

export type SchemaIngestion = typeof schema
