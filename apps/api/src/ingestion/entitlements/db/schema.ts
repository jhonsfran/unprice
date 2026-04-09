import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const meterStateTable = sqliteTable("meter_state", {
  key: text("key").primaryKey(),
  value: real("value").notNull(),
})

export const meterFactsOutboxTable = sqliteTable("meter_facts_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  currency: text("currency").notNull(),
  billedAt: integer("billed_at"),
})

export const idempotencyKeysTable = sqliteTable("idempotency_keys", {
  eventId: text("eventId").primaryKey(),
  createdAt: integer("createdAt").notNull(),
  result: text("result").notNull(),
})

export const schema = {
  meterStateTable,
  meterFactsOutboxTable,
  idempotencyKeysTable,
}

export type SchemaIngestion = typeof schema
