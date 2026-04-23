import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  json,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { walletGrantMetadataSchema } from "../validators/wallets"
import { customers } from "./customers"
import { walletGrantSourceEnum } from "./enums"
import { projects } from "./projects"

/**
 * Tracks promotional / plan-included / trial / manual credits so they
 * can be attributed and expired. The ledger holds the actual money in
 * `customer.{cid}.available.granted`; this table records per-grant
 * metadata (source, issued amount, remaining amount, expiry).
 *
 * Invariant (checked nightly):
 *   SUM(remaining_amount) WHERE expired_at IS NULL AND voided_at IS NULL
 *     == balance of customer.{cid}.available.granted
 *
 * Amounts are pgledger scale 8 (1 USD = 100_000_000).
 */
export const walletGrants = pgTableProject(
  "wallet_grants",
  {
    ...projectID,
    customerId: cuid("customer_id").notNull(),
    source: walletGrantSourceEnum("source").notNull(),
    // Originally credited amount (immutable once the grant is issued).
    issuedAmount: bigint("issued_amount", { mode: "number" }).notNull(),
    // Unspent amount — decremented as drains consume this grant FIFO.
    remainingAmount: bigint("remaining_amount", { mode: "number" }).notNull(),
    // NULL = never expires.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Set by the expiration job when remaining is clawed back.
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    // Set when an operator manually voids the grant.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // Points to the original credit transfer
    // (platform.funding.{source} → customer.available.granted).
    ledgerTransferId: text("ledger_transfer_id").notNull(),
    metadata: json("metadata").$type<z.infer<typeof walletGrantMetadataSchema>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "wallet_grants_pkey",
    }),
    // Idempotency: one wallet_grants row per original credit transfer.
    ledgerTransfer: uniqueIndex("wallet_grants_ledger_transfer_idx").on(
      table.customerId,
      table.ledgerTransferId
    ),
    // FIFO drain lookup: active grants for a customer ordered by expiry.
    activeByCustomerExpiry: index("wallet_grants_active_customer_expiry_idx")
      .on(table.customerId, table.expiresAt)
      .where(sql`${table.expiredAt} IS NULL AND ${table.voidedAt} IS NULL`),
    // Expiration sweep: scan grants whose expiry has passed.
    expirationSweep: index("wallet_grants_expiration_sweep_idx")
      .on(table.expiresAt)
      .where(
        sql`${table.expiredAt} IS NULL AND ${table.voidedAt} IS NULL AND ${table.remainingAmount} > 0`
      ),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "wallet_grants_customer_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "wallet_grants_project_id_fkey",
    }).onDelete("cascade"),
  })
)

export const walletGrantsRelations = relations(walletGrants, ({ one }) => ({
  project: one(projects, {
    fields: [walletGrants.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [walletGrants.customerId, walletGrants.projectId],
    references: [customers.id, customers.projectId],
  }),
}))
