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

export const meterPricingTable = sqliteTable("meter_pricing", {
  meterKey: text("meter_key").primaryKey(),
  currency: text("currency").notNull(),
  priceConfig: text("price_config", { mode: "json" }).$type<ConfigFeatureVersionType>().notNull(),
  createdAt: integer("created_at").notNull(),
})

export const meterStateTable = sqliteTable("meter_state", {
  key: text("key").primaryKey(),
  value: real("value").notNull(),
})

export const schema = {
  meterStateTable,
  meterFactsOutboxTable,
  idempotencyKeysTable,
  meterPricingTable,
}

export type SchemaIngestion = typeof schema
