import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { projects } from "./projects"

/**
 * Reservation state machine. One row per active DO reservation
 * (entitlement × billing period). Tracks the pgledger-funded
 * allocation the DO is authorized to consume locally.
 *
 * All amount columns are pgledger scale 8 (1 USD = 100_000_000).
 *
 * Lifecycle:
 *   - INSERT on subscription activation (via `walletService.createReservation`).
 *   - `allocation_amount` monotonically grows as the DO refills.
 *   - `consumed_amount` syncs at each flush to mirror DO SQLite.
 *   - `reconciled_at` set by the final flush; NULL = active.
 */
export const entitlementReservations = pgTableProject(
  "entitlement_reservations",
  {
    ...projectID,
    customerId: cuid("customer_id").notNull(),
    // Computed entitlement identifier (stable across the billing period).
    // Entitlements are derived from grants; this column is not an FK.
    entitlementId: cuid("entitlement_id").notNull(),
    // Total amount ever moved into reserved for this period.
    allocationAmount: bigint("allocation_amount", { mode: "number" }).notNull(),
    // Mirror of DO-side consumed counter, synced on each flush.
    consumedAmount: bigint("consumed_amount", { mode: "number" }).notNull().default(0),
    // Refill trigger threshold in basis points of allocation (2000 = 20%).
    refillThresholdBps: integer("refill_threshold_bps").notNull().default(2000),
    // Size of each refill chunk in scale-8 minor units.
    refillChunkAmount: bigint("refill_chunk_amount", { mode: "number" }).notNull(),
    periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull(),
    periodEndAt: timestamp("period_end_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // Set by the final flush. NULL = active reservation.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "entitlement_reservations_pkey",
    }),
    // One active reservation per entitlement per period.
    entitlementPeriod: uniqueIndex("entitlement_reservations_entitlement_period_idx").on(
      table.projectId,
      table.entitlementId,
      table.periodStartAt
    ),
    customerId: index("entitlement_reservations_customer_idx").on(
      table.projectId,
      table.customerId
    ),
    activePeriodEnd: index("entitlement_reservations_active_period_end_idx")
      .on(table.periodEndAt)
      .where(sql`${table.reconciledAt} IS NULL`),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "entitlement_reservations_customer_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "entitlement_reservations_project_id_fkey",
    }).onDelete("cascade"),
  })
)

export const entitlementReservationsRelations = relations(entitlementReservations, ({ one }) => ({
  project: one(projects, {
    fields: [entitlementReservations.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [entitlementReservations.customerId, entitlementReservations.projectId],
    references: [customers.id, customers.projectId],
  }),
}))
