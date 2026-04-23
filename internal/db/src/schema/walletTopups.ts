import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { currencyEnum, walletTopupStatusEnum } from "./enums"
import { projects } from "./projects"

/**
 * Top-up state machine. Row is inserted when the customer starts a
 * checkout session (tRPC `initiate`). The ledger transfer only happens
 * when the payment provider webhook confirms settlement — at which point
 * the row moves to `completed` and `ledger_transfer_id` is populated.
 *
 * Lifecycle:
 *   - INSERT (pending) ← tRPC initiate
 *   - UPDATE → completed + ledger_transfer_id  ← webhook → settleTopUp
 *   - UPDATE → failed / expired                 ← webhook or 24h sweep
 *
 * Amounts are pgledger scale 8 (1 USD = 100_000_000).
 */
export const walletTopups = pgTableProject(
  "wallet_topups",
  {
    ...projectID,
    customerId: cuid("customer_id").notNull(),
    // Payment provider identifier (e.g. 'stripe', 'polar', 'sandbox').
    // Kept as text — this is orthogonal to the configured invoice
    // payment provider and may evolve independently.
    provider: text("provider").notNull(),
    providerSessionId: text("provider_session_id").notNull(),
    // Amount the customer requested at checkout, in scale-8 minor units.
    requestedAmount: bigint("requested_amount", { mode: "number" }).notNull(),
    currency: currencyEnum("currency").notNull(),
    status: walletTopupStatusEnum("status").notNull(),
    // Amount actually settled by the provider (may differ from requested
    // for partial captures / fees). Populated on completion.
    settledAmount: bigint("settled_amount", { mode: "number" }),
    // Populated when the webhook settles the top-up — points to the
    // `platform.funding.topup → customer.available.purchased` transfer.
    ledgerTransferId: text("ledger_transfer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "wallet_topups_pkey",
    }),
    // Idempotency anchor for provider webhooks.
    providerSession: uniqueIndex("wallet_topups_provider_session_idx").on(
      table.provider,
      table.providerSessionId
    ),
    customerCreated: index("wallet_topups_customer_created_idx").on(
      table.projectId,
      table.customerId,
      table.createdAt
    ),
    // Used by the stranded-topup sweep (older than 24h).
    pendingSweep: index("wallet_topups_pending_sweep_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "wallet_topups_customer_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "wallet_topups_project_id_fkey",
    }).onDelete("cascade"),
  })
)

export const walletTopupsRelations = relations(walletTopups, ({ one }) => ({
  project: one(projects, {
    fields: [walletTopups.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [walletTopups.customerId, walletTopups.projectId],
    references: [customers.id, customers.projectId],
  }),
}))
