import { relations } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type {
  customerProviderMetadataSchema,
  webhookEventErrorSchema,
  webhookEventHeadersSchema,
} from "../validators/providerData"
import { customers } from "./customers"
import { paymentProviderEnum } from "./enums"
import { projects } from "./projects"

export const customerProviderIds = pgTableProject(
  "customer_provider_ids",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    provider: paymentProviderEnum("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    metadata: json("metadata").$type<z.infer<typeof customerProviderMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "customer_provider_ids_pkey",
    }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "customer_provider_ids_customer_id_fkey",
    }).onDelete("cascade"),
    uniqCustomerProvider: uniqueIndex("customer_provider_ids_customer_provider_uq").on(
      table.projectId,
      table.customerId,
      table.provider
    ),
    uniqProviderCustomerId: uniqueIndex("customer_provider_ids_provider_customer_uq").on(
      table.projectId,
      table.provider,
      table.providerCustomerId
    ),
    customerIdx: index("customer_provider_ids_customer_idx").on(table.projectId, table.customerId),
  })
)

export const webhookEvents = pgTableProject(
  "webhook_events",
  {
    ...projectID,
    ...timestamps,
    provider: paymentProviderEnum("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    rawPayload: text("raw_payload").notNull(),
    status: text("status").notNull().default("pending"),
    signature: text("signature"),
    headers: json("headers").$type<z.infer<typeof webhookEventHeadersSchema>>(),
    attempts: integer("attempts").notNull().default(0),
    processedAtM: bigint("processed_at_m", { mode: "number" }),
    errorPayload: json("error_payload").$type<z.infer<typeof webhookEventErrorSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "webhook_events_pkey",
    }),
    uniqProviderEvent: uniqueIndex("webhook_events_provider_event_uq").on(
      table.projectId,
      table.provider,
      table.providerEventId
    ),
    statusIdx: index("webhook_events_status_idx").on(table.projectId, table.status),
  })
)

export const customerProviderIdsRelations = relations(customerProviderIds, ({ one }) => ({
  customer: one(customers, {
    fields: [customerProviderIds.customerId, customerProviderIds.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, {
    fields: [customerProviderIds.projectId],
    references: [projects.id],
  }),
}))

export const webhookEventsRelations = relations(webhookEvents, ({ one }) => ({
  project: one(projects, {
    fields: [webhookEvents.projectId],
    references: [projects.id],
  }),
}))
