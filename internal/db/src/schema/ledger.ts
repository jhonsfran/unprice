import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  json,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { currencyEnum, ledgerEntryTypeEnum } from "./enums"
import { projects } from "./projects"

export type LedgerEntryMetadata = {
  subscriptionId?: string | null
  subscriptionPhaseId?: string | null
  subscriptionItemId?: string | null
  billingPeriodId?: string | null
  featurePlanVersionId?: string | null
  invoiceItemKind?: "period" | "tax" | "discount" | "refund" | "adjustment" | "trial" | null
  cycleStartAt?: number | null
  cycleEndAt?: number | null
  quantity?: number | null
  /** Scale-6 minor units stored as string for JSON serialization. Must be a valid integer string. */
  unitAmountMinor?: string | null
  prorationFactor?: number | null
  /** ID of the billing fact stored in the analytics pipeline (ClickHouse/Tinybird). */
  billingFactId?: string | null
  reversalOf?: string
  reason?: string
}

export type LedgerSettlementMetadata = {
  note?: string
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const ledgers = pgTableProject(
  "ledgers",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    currency: currencyEnum("currency").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "bigint" }).notNull().default(sql`0`),
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
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    signedAmountMinor: bigint("signed_amount_minor", { mode: "bigint" }).notNull(),
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    sourceId: varchar("source_id", { length: 160 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    description: varchar("description", { length: 255 }),
    statementKey: varchar("statement_key", { length: 64 }),
    balanceAfterMinor: bigint("balance_after_minor", { mode: "bigint" }).notNull().default(sql`0`),
    journalId: varchar("journal_id", { length: 64 }),
    metadata: json("metadata").$type<LedgerEntryMetadata>(),
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
    idxStatement: index("ledger_entries_statement_idx").on(table.projectId, table.statementKey),
    idxJournal: index("ledger_entries_journal_idx")
      .on(table.projectId, table.journalId)
      .where(sql`${table.journalId} IS NOT NULL`),
  })
)

/**
 * Append-only settlement records. Settlement state (pending/confirmed/reversed) lives
 * here, NOT on entries. Entries are immutable facts.
 *
 * State machine: pending → confirmed | pending → reversed | confirmed → reversed
 * "reversed" is terminal — re-settlement creates a new record.
 *
 * Using varchar(32) for type/status (not pgEnum) so new settlement methods
 * (wallet, crypto) can be added without DDL migrations.
 */
export const ledgerSettlements = pgTableProject(
  "ledger_settlements",
  {
    ...projectID,
    ...timestamps,
    ledgerId: cuid("ledger_id").notNull(),
    // "invoice" | "manual" | "wallet" | "one_time"
    type: varchar("type", { length: 32 }).notNull(),
    artifactId: varchar("artifact_id", { length: 160 }).notNull(),
    // "pending" | "confirmed" | "reversed"
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    reversesSettlementId: cuid("reverses_settlement_id"),
    confirmedAt: bigint("confirmed_at_m", { mode: "number" }),
    reversedAt: bigint("reversed_at_m", { mode: "number" }),
    reversalReason: varchar("reversal_reason", { length: 255 }),
    metadata: json("metadata").$type<LedgerSettlementMetadata>(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "ledger_settlements_pkey",
    }),
    ledgerfk: foreignKey({
      columns: [table.ledgerId, table.projectId],
      foreignColumns: [ledgers.id, ledgers.projectId],
      name: "ledger_settlements_ledger_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "ledger_settlements_project_id_fkey",
    }).onDelete("cascade"),
    // one active settlement per (ledger, artifact, type)
    uqArtifact: uniqueIndex("ledger_settlements_artifact_uq").on(
      table.projectId,
      table.ledgerId,
      table.artifactId,
      table.type
    ),
    idxByArtifact: index("ledger_settlements_artifact_idx").on(
      table.projectId,
      table.type,
      table.artifactId
    ),
    idxByStatus: index("ledger_settlements_status_idx").on(
      table.projectId,
      table.ledgerId,
      table.status
    ),
  })
)

/**
 * One row per entry included in a settlement. Supports partial settlement
 * (amountMinor may be less than the entry's full amount for Phase 7 wallet splits).
 */
export const ledgerSettlementLines = pgTableProject(
  "ledger_settlement_lines",
  {
    ...projectID,
    createdAtM: bigint("created_at_m", { mode: "number" })
      .notNull()
      .default(0)
      .$defaultFn(() => Date.now()),
    settlementId: cuid("settlement_id").notNull(),
    ledgerEntryId: cuid("ledger_entry_id").notNull(),
    // Amount being settled (scale 6). May differ from entry amount for partial settlement.
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "ledger_settlement_lines_pkey",
    }),
    settlementfk: foreignKey({
      columns: [table.settlementId, table.projectId],
      foreignColumns: [ledgerSettlements.id, ledgerSettlements.projectId],
      name: "ledger_settlement_lines_settlement_id_fkey",
    }).onDelete("cascade"),
    entryfk: foreignKey({
      columns: [table.ledgerEntryId, table.projectId],
      foreignColumns: [ledgerEntries.id, ledgerEntries.projectId],
      name: "ledger_settlement_lines_entry_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "ledger_settlement_lines_project_id_fkey",
    }).onDelete("cascade"),
    uqLine: uniqueIndex("ledger_settlement_lines_uq").on(
      table.projectId,
      table.settlementId,
      table.ledgerEntryId
    ),
    // Anti-join index used by getUnsettledEntries NOT EXISTS query
    idxByEntry: index("ledger_settlement_lines_entry_idx").on(table.projectId, table.ledgerEntryId),
  })
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

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
  settlements: many(ledgerSettlements),
}))

export const ledgerEntryRelations = relations(ledgerEntries, ({ one, many }) => ({
  ledger: one(ledgers, {
    fields: [ledgerEntries.ledgerId, ledgerEntries.projectId],
    references: [ledgers.id, ledgers.projectId],
  }),
  customer: one(customers, {
    fields: [ledgerEntries.customerId, ledgerEntries.projectId],
    references: [customers.id, customers.projectId],
  }),
  settlementLines: many(ledgerSettlementLines),
}))

export const ledgerSettlementRelations = relations(ledgerSettlements, ({ one, many }) => ({
  ledger: one(ledgers, {
    fields: [ledgerSettlements.ledgerId, ledgerSettlements.projectId],
    references: [ledgers.id, ledgers.projectId],
  }),
  project: one(projects, {
    fields: [ledgerSettlements.projectId],
    references: [projects.id],
  }),
  lines: many(ledgerSettlementLines),
}))

export const ledgerSettlementLineRelations = relations(ledgerSettlementLines, ({ one }) => ({
  settlement: one(ledgerSettlements, {
    fields: [ledgerSettlementLines.settlementId, ledgerSettlementLines.projectId],
    references: [ledgerSettlements.id, ledgerSettlements.projectId],
  }),
  entry: one(ledgerEntries, {
    fields: [ledgerSettlementLines.ledgerEntryId, ledgerSettlementLines.projectId],
    references: [ledgerEntries.id, ledgerEntries.projectId],
  }),
}))
