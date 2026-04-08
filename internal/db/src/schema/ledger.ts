import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { billingPeriods } from "./billingPeriods"
import { customers } from "./customers"
import {
  currencyEnum,
  invoiceItemKindEnum,
  ledgerEntryTypeEnum,
  ledgerSettlementTypeEnum,
} from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems, subscriptionPhases, subscriptions } from "./subscriptions"

export const ledgers = pgTableProject(
  "ledgers",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    currency: currencyEnum("currency").notNull(),
    // Running all-time signed balance for this ledger.
    balanceCents: integer("balance_cents").notNull().default(0),
    // Running signed balance of entries that are not yet settled.
    unsettledBalanceCents: integer("unsettled_balance_cents").notNull().default(0),
    lastEntryAt: bigint("last_entry_at_m", { mode: "number" }),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "ledgers_pkey",
    }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "ledgers_customer_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "ledgers_project_id_fkey",
    }).onDelete("cascade"),
    uqCustomerCurrency: uniqueIndex("ledgers_customer_currency_uq").on(
      table.projectId,
      table.customerId,
      table.currency
    ),
    idxCustomer: index("ledgers_customer_idx").on(table.projectId, table.customerId),
  })
)

export const ledgerEntries = pgTableProject(
  "ledger_entries",
  {
    ...projectID,
    ...timestamps,
    ledgerId: cuid("ledger_id").notNull(),
    customerId: cuid("customer_id").notNull(),
    currency: currencyEnum("currency").notNull(),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    // Absolute amount in cents represented by this entry.
    amountCents: integer("amount_cents").notNull(),
    // Signed amount (+debit / -credit) used for balances.
    signedAmountCents: integer("signed_amount_cents").notNull(),
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    sourceId: varchar("source_id", { length: 160 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    description: varchar("description", { length: 255 }),
    statementKey: varchar("statement_key", { length: 64 }),
    subscriptionId: cuid("subscription_id"),
    subscriptionPhaseId: cuid("subscription_phase_id"),
    subscriptionItemId: cuid("subscription_item_id"),
    billingPeriodId: cuid("billing_period_id"),
    featurePlanVersionId: cuid("feature_plan_version_id"),
    invoiceItemKind: invoiceItemKindEnum("invoice_item_kind").notNull().default("period"),
    cycleStartAt: bigint("cycle_start_at_m", { mode: "number" }),
    cycleEndAt: bigint("cycle_end_at_m", { mode: "number" }),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: integer("unit_amount_cents"),
    amountSubtotalCents: integer("amount_subtotal_cents").notNull().default(0),
    amountTotalCents: integer("amount_total_cents").notNull().default(0),
    // Running signed balance after this entry is appended.
    balanceAfterCents: integer("balance_after_cents").notNull().default(0),
    settlementType: ledgerSettlementTypeEnum("settlement_type"),
    settlementArtifactId: text("settlement_artifact_id"),
    settlementPendingProviderConfirmation: boolean("settlement_pending_provider_confirmation")
      .notNull()
      .default(false),
    settledAt: bigint("settled_at_m", { mode: "number" }),
    metadata: json("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "ledger_entries_pkey",
    }),
    ledgerfk: foreignKey({
      columns: [table.ledgerId, table.projectId],
      foreignColumns: [ledgers.id, ledgers.projectId],
      name: "ledger_entries_ledger_id_fkey",
    }).onDelete("cascade"),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "ledger_entries_customer_id_fkey",
    }).onDelete("cascade"),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "ledger_entries_subscription_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "ledger_entries_subscription_phase_id_fkey",
    }).onDelete("cascade"),
    subscriptionItemfk: foreignKey({
      columns: [table.subscriptionItemId, table.projectId],
      foreignColumns: [subscriptionItems.id, subscriptionItems.projectId],
      name: "ledger_entries_subscription_item_id_fkey",
    }).onDelete("cascade"),
    billingPeriodfk: foreignKey({
      columns: [table.billingPeriodId, table.projectId],
      foreignColumns: [billingPeriods.id, billingPeriods.projectId],
      name: "ledger_entries_billing_period_id_fkey",
    }).onDelete("cascade"),
    featurePlanVersionfk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "ledger_entries_feature_plan_version_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "ledger_entries_project_id_fkey",
    }).onDelete("cascade"),
    uqSourceIdentity: uniqueIndex("ledger_entries_source_identity_uq").on(
      table.projectId,
      table.ledgerId,
      table.sourceType,
      table.sourceId
    ),
    uqIdempotency: uniqueIndex("ledger_entries_idempotency_uq").on(
      table.projectId,
      table.ledgerId,
      table.idempotencyKey
    ),
    idxUnsettled: index("ledger_entries_unsettled_idx")
      .on(table.projectId, table.ledgerId, table.statementKey, table.createdAtM)
      .where(sql`${table.settledAt} IS NULL`),
    idxStatement: index("ledger_entries_statement_idx").on(
      table.projectId,
      table.subscriptionId,
      table.statementKey
    ),
    idxSettlementArtifact: index("ledger_entries_settlement_artifact_idx").on(
      table.projectId,
      table.settlementType,
      table.settlementArtifactId
    ),
  })
)

export const ledgerRelations = relations(ledgers, ({ one, many }) => ({
  project: one(projects, {
    fields: [ledgers.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [ledgers.customerId, ledgers.projectId],
    references: [customers.id, customers.projectId],
  }),
  entries: many(ledgerEntries),
}))

export const ledgerEntryRelations = relations(ledgerEntries, ({ one }) => ({
  ledger: one(ledgers, {
    fields: [ledgerEntries.ledgerId, ledgerEntries.projectId],
    references: [ledgers.id, ledgers.projectId],
  }),
  customer: one(customers, {
    fields: [ledgerEntries.customerId, ledgerEntries.projectId],
    references: [customers.id, customers.projectId],
  }),
  subscription: one(subscriptions, {
    fields: [ledgerEntries.subscriptionId, ledgerEntries.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [ledgerEntries.subscriptionPhaseId, ledgerEntries.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  subscriptionItem: one(subscriptionItems, {
    fields: [ledgerEntries.subscriptionItemId, ledgerEntries.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
  billingPeriod: one(billingPeriods, {
    fields: [ledgerEntries.billingPeriodId, ledgerEntries.projectId],
    references: [billingPeriods.id, billingPeriods.projectId],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [ledgerEntries.featurePlanVersionId, ledgerEntries.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
}))
