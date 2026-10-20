import { sql } from "drizzle-orm"
import { index, integer, json, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projectID } from "../utils/sql"
import type {
  BudgetAuditAction,
  BudgetAuditStatus,
  BudgetCap,
  BudgetCatalogLimit,
  BudgetReleaseRejectionCode,
} from "../validators/budgets"

/**
 * The budgets catalog: one row per budget key, written after each upsert that changed the
 * budget's config. The budget's Durable Object stays the only source of balances; this table
 * holds configuration facts so the dashboard can list budgets without waking an object.
 */
export const budgets = pgTableProject(
  "budgets",
  {
    ...projectID,
    key: text("key").notNull(),
    unit: text("unit").notNull(),
    version: integer("version").notNull(),
    cap: text("cap").$type<BudgetCap>().notNull(),
    limits: json("limits").$type<BudgetCatalogLimit[]>().notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "budgets_pkey" }),
    // text_pattern_ops serves the key-prefix LIKE whatever the database collation is.
    projectKeyIdx: uniqueIndex("budgets_project_key_idx").on(
      table.projectId,
      table.key.op("text_pattern_ops")
    ),
    projectUpdatedIdx: index("budgets_project_updated_idx").on(table.projectId, table.updatedAt),
  })
)

/**
 * One row per operator action on a budget, written before the call and resolved after it. It
 * names the budget by its catalog id and never copies the key. A subject is its id plus the time
 * the budget created it. A budget recreated at the same key keeps its catalog id but restarts its
 * hold ids, so the id alone would match the closed budget's row.
 */
export const budgetAudit = pgTableProject(
  "budget_audit",
  {
    ...projectID,
    budgetId: cuid("budget_id").notNull(),
    action: text("action").$type<BudgetAuditAction>().notNull(),
    subject: text("subject").notNull(),
    subjectCreatedAt: timestamp("subject_created_at", { withTimezone: true }).notNull(),
    actorUserId: cuid("actor_user_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").$type<BudgetAuditStatus>().notNull(),
    released: text("released"),
    rejectionCode: text("rejection_code").$type<BudgetReleaseRejectionCode>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.id, table.projectId], name: "budget_audit_pkey" }),
    subjectIdx: uniqueIndex("budget_audit_subject_idx").on(
      table.projectId,
      table.budgetId,
      table.action,
      table.subject,
      table.subjectCreatedAt
    ),
    budgetCreatedIdx: index("budget_audit_budget_created_idx").on(
      table.projectId,
      table.budgetId,
      table.createdAt
    ),
  })
)
