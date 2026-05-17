import { relations, sql } from "drizzle-orm"
import {
  bigint,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { walletCreditSourceEnum } from "./enums"
import { projects } from "./projects"
import { walletCredits } from "./walletCredits"

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
 *   - `consumed_amount` syncs at each capture to mirror DO SQLite.
 *   - Funding attribution lives in entitlement_reservation_funding_legs.
 *   - `reconciled_at` set when the reservation is released; NULL = active.
 */
export type EntitlementReservationMetadata = Record<string, unknown>

export const entitlementReservations = pgTableProject(
  "entitlement_reservations",
  {
    ...projectID,
    customerId: cuid("customer_id").notNull(),
    // Customer entitlements own the window; grants are allowance chunks under it.
    entitlementId: cuid("entitlement_id").notNull(),
    // Total amount ever moved into reserved for this period.
    allocationAmount: bigint("allocation_amount", { mode: "number" }).notNull(),
    // Mirror of DO-side consumed counter, synced on each flush.
    consumedAmount: bigint("consumed_amount", { mode: "number" }).notNull().default(0),
    // Operational trace context for the reservation owner (for example the DO id).
    metadata: json("metadata").$type<EntitlementReservationMetadata>(),
    // Refill trigger threshold in basis points of allocation (2000 = 20%).
    refillThresholdBps: integer("refill_threshold_bps").notNull().default(2000),
    // Size of each refill chunk in scale-8 minor units.
    refillChunkAmount: bigint("refill_chunk_amount", { mode: "number" }).notNull(),
    periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull(),
    periodEndAt: timestamp("period_end_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    // Set when the reservation is released. NULL = active reservation.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "entitlement_reservations_pkey",
    }),
    // At most one *active* reservation per (project, entitlement, period).
    // The partial predicate is essential: a closed (reconciled) reservation
    // shouldn't block re-bootstrapping a new one for the same period — that
    // happens after a final flush (limit-exceeded close, inactivity, etc.)
    // followed by a fresh apply() on the DO.
    entitlementPeriod: uniqueIndex("entitlement_reservations_entitlement_period_idx")
      .on(table.projectId, table.entitlementId, table.periodStartAt)
      .where(sql`${table.reconciledAt} IS NULL`),
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

export const entitlementReservationFundingLegs = pgTableProject(
  "entitlement_reservation_funding_legs",
  {
    ...projectID,
    reservationId: cuid("reservation_id").notNull(),
    source: text("source").$type<"granted" | "purchased">().notNull(),
    walletCreditId: cuid("wallet_credit_id"),
    grantSource: walletCreditSourceEnum("grant_source"),
    allocatedAmount: bigint("allocated_amount", { mode: "number" }).notNull(),
    capturedAmount: bigint("captured_amount", { mode: "number" }).notNull().default(0),
    releasedAmount: bigint("released_amount", { mode: "number" }).notNull().default(0),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "entitlement_reservation_funding_legs_pkey",
    }),
    reservationSequence: uniqueIndex("entitlement_reservation_funding_legs_res_seq_idx").on(
      table.projectId,
      table.reservationId,
      table.sequence
    ),
    reservation: index("entitlement_reservation_funding_legs_reservation_idx").on(
      table.projectId,
      table.reservationId
    ),
    walletCredit: index("entitlement_reservation_funding_legs_wallet_credit_idx").on(
      table.projectId,
      table.walletCreditId
    ),
    reservationfk: foreignKey({
      columns: [table.reservationId, table.projectId],
      foreignColumns: [entitlementReservations.id, entitlementReservations.projectId],
      name: "entitlement_reservation_funding_legs_reservation_id_fkey",
    }).onDelete("cascade"),
    walletCreditfk: foreignKey({
      columns: [table.walletCreditId, table.projectId],
      foreignColumns: [walletCredits.id, walletCredits.projectId],
      name: "entitlement_reservation_funding_legs_wallet_credit_id_fkey",
    }).onDelete("restrict"),
  })
)

export const entitlementReservationsRelations = relations(
  entitlementReservations,
  ({ many, one }) => ({
    project: one(projects, {
      fields: [entitlementReservations.projectId],
      references: [projects.id],
    }),
    customer: one(customers, {
      fields: [entitlementReservations.customerId, entitlementReservations.projectId],
      references: [customers.id, customers.projectId],
    }),
    fundingLegs: many(entitlementReservationFundingLegs),
  })
)

export const entitlementReservationFundingLegsRelations = relations(
  entitlementReservationFundingLegs,
  ({ one }) => ({
    project: one(projects, {
      fields: [entitlementReservationFundingLegs.projectId],
      references: [projects.id],
    }),
    reservation: one(entitlementReservations, {
      fields: [
        entitlementReservationFundingLegs.reservationId,
        entitlementReservationFundingLegs.projectId,
      ],
      references: [entitlementReservations.id, entitlementReservations.projectId],
    }),
    walletCredit: one(walletCredits, {
      fields: [
        entitlementReservationFundingLegs.walletCreditId,
        entitlementReservationFundingLegs.projectId,
      ],
      references: [walletCredits.id, walletCredits.projectId],
    }),
  })
)
