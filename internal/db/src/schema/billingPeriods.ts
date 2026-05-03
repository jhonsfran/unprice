import { relations } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { billingPeriodStatusEnum, billingPeriodTypeEnum, whenToBillEnum } from "./enums"
import { invoices } from "./invoices"
import { projects } from "./projects"
import { subscriptionItems, subscriptionPhases, subscriptions } from "./subscriptions"

export const billingPeriods = pgTableProject(
  "billing_periods",
  {
    ...projectID,
    ...timestamps,
    // Is it necessary to have the subscription id?
    subscriptionId: cuid("subscription_id").notNull(),
    // customer id is the id of the customer that is associated with the billing period
    customerId: cuid("customer_id").notNull(),
    subscriptionPhaseId: cuid("subscription_phase_id").notNull(),
    subscriptionItemId: cuid("subscription_item_id").notNull(),
    status: billingPeriodStatusEnum("status").notNull().default("pending"),
    type: billingPeriodTypeEnum("type").notNull().default("normal"),
    cycleStartAt: bigint("cycle_start_at_m", { mode: "number" }).notNull(),
    cycleEndAt: bigint("cycle_end_at_m", { mode: "number" }).notNull(),
    amountEstimate: bigint("amount_estimate", { mode: "number" }),
    reason: varchar("reason", { length: 64 }).$type<"normal" | "mid_cycle_change" | "trial">(), // annual_renewal|monthly_usage|mid_cycle_change|trial
    // invoice id is the invoice that is associated with the billing period can be null if the billing period is not invoiced yet
    invoiceId: cuid("invoice_id"),
    // handles when the invoice is generated (prepaid or postpaid)
    whenToBill: whenToBillEnum("when_to_bill").notNull().default("pay_in_advance"),
    invoiceAt: bigint("invoice_at_m", { mode: "number" }).notNull(),
    // statementKey is a deliberate grouping key so multiple billing_periods
    // with different service windows can be billed together on one invoice
    // Purpose: co-bill:
    // Prepaid base for [nextStart, nextEnd]
    // Arrears usage for [prevStart, prevEnd]
    // on a single invoice, even though the line windows differ
    // subscriptionId + invoiceAt
    statementKey: varchar("statement_key", { length: 64 }).notNull(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "billing_periods_pkey",
    }),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "billing_periods_subscription_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "billing_periods_subscription_phase_id_fkey",
    }).onDelete("cascade"),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "billing_periods_customer_id_fkey",
    }).onDelete("cascade"),
    // project fk
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "billing_periods_project_id_fkey",
    }).onDelete("cascade"),
    subscriptionItemfk: foreignKey({
      columns: [table.subscriptionItemId, table.projectId],
      foreignColumns: [subscriptionItems.id, subscriptionItems.projectId],
      name: "billing_periods_subscription_item_id_fkey",
    }).onDelete("cascade"),
    invoicefk: foreignKey({
      columns: [table.invoiceId, table.projectId],
      foreignColumns: [invoices.id, invoices.projectId],
      name: "billing_periods_invoice_id_fkey",
    }).onDelete("cascade"),
    periodUnique: uniqueIndex("billing_periods_period_unique").on(
      table.projectId,
      table.subscriptionId,
      table.subscriptionPhaseId,
      table.subscriptionItemId,
      table.cycleStartAt,
      table.cycleEndAt
    ),
    idxBillAt: index("billing_periods_bill_at_idx").on(
      table.projectId,
      table.status,
      table.invoiceAt
    ),
    idxStatement: index("billing_periods_statement_idx").on(
      table.projectId,
      table.subscriptionId,
      table.statementKey
    ),
  })
)

export const billingPeriodRelations = relations(billingPeriods, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [billingPeriods.subscriptionId, billingPeriods.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  project: one(projects, {
    fields: [billingPeriods.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [billingPeriods.customerId, billingPeriods.projectId],
    references: [customers.id, customers.projectId],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [billingPeriods.subscriptionPhaseId, billingPeriods.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  subscriptionItem: one(subscriptionItems, {
    fields: [billingPeriods.subscriptionItemId, billingPeriods.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
}))
