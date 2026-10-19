import { sql } from "drizzle-orm"
import { index, integer, json, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { pgTableProject } from "../utils/_table"
import { projectID } from "../utils/sql"
import type { BudgetCap, BudgetCatalogLimit } from "../validators/budgets"

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
