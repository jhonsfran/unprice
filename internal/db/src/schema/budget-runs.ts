import { relations, sql } from "drizzle-orm"
import { bigint, index, json, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { projects } from "./projects"

export type BudgetRunStatus =
  | "running"
  | "completed"
  | "expired"
  | "canceled"
  | "budget_exceeded"
  | "failed"

export type BudgetRunWorkloadType = "agent" | "workflow" | "job" | "tool" | "custom"

/**
 * Budget run state. One row per run lifecycle.
 *
 * All amount columns (budget_amount, consumed_amount, remaining_amount) are
 * pgledger scale 8 (1 USD = 100_000_000). This matches entitlement reservations,
 * wallet operations, and priced meter facts throughout the system.
 */
export const budgetRuns = pgTableProject(
  "budget_runs",
  {
    ...projectID,
    customerId: cuid("customer_id").notNull(),
    status: text("status").$type<BudgetRunStatus>().notNull().default("running"),
    statusReason: text("status_reason"),
    budgetAmount: bigint("budget_amount", { mode: "number" }).notNull(),
    consumedAmount: bigint("consumed_amount", { mode: "number" }).notNull().default(0),
    remainingAmount: bigint("remaining_amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    walletReservationId: text("wallet_reservation_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    workloadType: text("workload_type").$type<BudgetRunWorkloadType>(),
    workloadId: text("workload_id"),
    traceId: text("trace_id"),
    parentRunId: cuid("parent_run_id"),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`now()`),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "budget_runs_pkey" }),
    projectCustomerIdx: index("budget_runs_project_customer_idx").on(
      table.projectId,
      table.customerId
    ),
    projectStatusIdx: index("budget_runs_project_status_idx").on(table.projectId, table.status),
    projectTraceIdx: index("budget_runs_project_trace_idx").on(table.projectId, table.traceId),
    projectParentIdx: index("budget_runs_project_parent_idx").on(
      table.projectId,
      table.parentRunId
    ),
    projectWorkloadIdx: index("budget_runs_project_workload_idx").on(
      table.projectId,
      table.workloadType,
      table.workloadId
    ),
    idempotencyIdx: uniqueIndex("budget_runs_project_customer_idempotency_idx").on(
      table.projectId,
      table.customerId,
      table.idempotencyKey
    ),
  })
)

export const budgetRunsRelations = relations(budgetRuns, ({ one }) => ({
  customer: one(customers, {
    fields: [budgetRuns.customerId, budgetRuns.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, { fields: [budgetRuns.projectId], references: [projects.id] }),
}))
