import { relations, sql } from "drizzle-orm"
import { bigint, index, json, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { projects } from "./projects"

export type AgentMetadata = Record<string, unknown>
export type AgentRunMetadata = Record<string, unknown>
export type AgentRunStatus =
  | "running"
  | "completed"
  | "expired"
  | "canceled"
  | "budget_exceeded"
  | "failed"

export const agents = pgTableProject(
  "agents",
  {
    ...projectID,
    name: text("name").notNull(),
    description: text("description"),
    metadata: json("metadata").$type<AgentMetadata>().notNull().default({}),
    active: text("active").$type<"true" | "false">().notNull().default("true"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "agents_pkey" }),
    projectActive: index("agents_project_active_idx").on(table.projectId, table.active),
  })
)

export const agentRuns = pgTableProject(
  "agent_runs",
  {
    ...projectID,
    agentId: cuid("agent_id").notNull(),
    customerId: cuid("customer_id").notNull(),
    parentRunId: cuid("parent_run_id"),
    status: text("status").$type<AgentRunStatus>().notNull().default("running"),
    currency: text("currency").notNull(),
    requestedBudgetAmount: bigint("requested_budget_amount", { mode: "number" }).notNull(),
    reservedAmount: bigint("reserved_amount", { mode: "number" }).notNull().default(0),
    consumedAmount: bigint("consumed_amount", { mode: "number" }).notNull().default(0),
    flushedAmount: bigint("flushed_amount", { mode: "number" }).notNull().default(0),
    reservationId: cuid("reservation_id"),
    traceId: text("trace_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: json("metadata").$type<AgentRunMetadata>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "agent_runs_pkey" }),
    agent: index("agent_runs_agent_idx").on(table.projectId, table.agentId),
    customer: index("agent_runs_customer_idx").on(table.projectId, table.customerId),
    activeExpiry: index("agent_runs_active_expiry_idx").on(
      table.projectId,
      table.status,
      table.expiresAt
    ),
    trace: index("agent_runs_trace_idx").on(table.projectId, table.traceId),
    idempotency: index("agent_runs_idempotency_idx").on(
      table.projectId,
      table.agentId,
      table.idempotencyKey
    ),
  })
)

export const agentsRelations = relations(agents, ({ many, one }) => ({
  project: one(projects, { fields: [agents.projectId], references: [projects.id] }),
  runs: many(agentRuns),
}))

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(agents, {
    fields: [agentRuns.agentId, agentRuns.projectId],
    references: [agents.id, agents.projectId],
  }),
  customer: one(customers, {
    fields: [agentRuns.customerId, agentRuns.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, { fields: [agentRuns.projectId], references: [projects.id] }),
}))
