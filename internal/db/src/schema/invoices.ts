import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  json,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { invoiceMetadataSchema } from "../validators/subscriptions"
import { customers } from "./customers"
import {
  collectionMethodEnum,
  currencyEnum,
  invoiceStatusEnum,
  paymentProviderEnum,
  whenToBillEnum,
} from "./enums"
import { projects } from "./projects"
import { subscriptions } from "./subscriptions"

export const invoices = pgTableProject(
  "invoices",
  {
    ...projectID,
    ...timestamps,
    subscriptionId: cuid("subscription_id").notNull(),
    customerId: cuid("customer_id").notNull(),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    // date the invoice was issued
    issueDate: bigint("issue_date_m", { mode: "number" }),
    requiredPaymentMethod: boolean("required_payment_method").notNull().default(false),
    paymentMethodId: text("payment_method_id"),
    // date statement (the date that is shown on the invoice)
    statementDateString: varchar("statement_date_string", { length: 255 }).notNull(),
    // statementKey is a deliberate grouping key to enforce uniqueness
    statementKey: varchar("statement_key", { length: 64 }).notNull(),
    // UI display purposes
    statementStartAt: bigint("statement_start_at_m", { mode: "number" }).notNull(),
    statementEndAt: bigint("statement_end_at_m", { mode: "number" }).notNull(),
    whenToBill: whenToBillEnum("when_to_bill").notNull().default("pay_in_advance"),
    collectionMethod: collectionMethodEnum("collection_method")
      .notNull()
      .default("charge_automatically"),
    paymentProvider: paymentProviderEnum("payment_providers").notNull(),
    currency: currencyEnum("currency").notNull(),
    sentAt: bigint("sent_at_m", { mode: "number" }),
    // when the invoice is due and ready to be billed
    dueAt: bigint("due_at_m", { mode: "number" }).notNull(),
    paidAt: bigint("paid_at_m", { mode: "number" }),
    // total amount of the invoice at pgledger scale 8 (1 USD = 100_000_000)
    totalAmount: bigint("total_amount", { mode: "number" }).notNull().default(0),
    invoicePaymentProviderId: text("invoice_payment_provider_id"),
    invoicePaymentProviderUrl: text("invoice_payment_provider_url"),
    // when the subscription is considered past due
    pastDueAt: bigint("past_due_at_m", { mode: "number" }).notNull(),
    metadata: json("metadata").$type<z.infer<typeof invoiceMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "invoices_pkey",
    }),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "invoices_subscription_id_fkey",
    }).onDelete("cascade"),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "invoices_customer_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "invoices_project_id_fkey",
    }).onDelete("cascade"),
    period: index("invoices_period_idx").on(
      table.projectId,
      table.subscriptionId,
      table.customerId,
      table.statementStartAt,
      table.statementEndAt
    ),
    statementKey: uniqueIndex("invoices_statement_key_idx").on(
      table.projectId,
      table.subscriptionId,
      table.customerId,
      table.statementKey
    ),
  })
)

export const invoiceRelations = relations(invoices, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId, invoices.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  project: one(projects, {
    fields: [invoices.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [invoices.customerId, invoices.projectId],
    references: [customers.id, customers.projectId],
  }),
}))
