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
export const meterWindowTable = sqliteTable("meter_window", {
  meterKey: text("meter_key").primaryKey(),
  currency: text("currency").notNull(),
  priceConfig: text("price_config", { mode: "json" }).$type<ConfigFeatureVersionType>().notNull(),
  periodEndAt: integer("period_end_at"),
  usage: real("usage").notNull().default(0),
  updatedAt: integer("updated_at"),
  createdAt: integer("created_at").notNull(),
})

export const schema = {
  meterFactsOutboxTable,
  idempotencyKeysTable,
  meterWindowTable,
}

export type SchemaIngestion = typeof schema
