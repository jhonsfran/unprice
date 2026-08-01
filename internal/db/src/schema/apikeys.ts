import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { customers } from "./customers"
import { projects } from "./projects"

/**
 * Runtime keys drive the money path (access checks, usage, runs). Config keys only
 * reach the monetization configuration operations. A key is one or the other.
 *
 * This is orthogonal to `isRoot`: `isRoot` widens *reach* (a root key may act across projects
 * in its workspace), `type` selects *which operation surface* the key can call at all. A key
 * can be root and config, or root and runtime; the two are checked independently.
 */
export const API_KEY_TYPES = ["runtime", "config"] as const

/** Every key predating the column, and every key created without an explicit choice. */
export const DEFAULT_API_KEY_TYPE = "runtime" satisfies (typeof API_KEY_TYPES)[number]

export const apikeys = pgTableProject(
  "apikeys",
  {
    ...projectID,
    ...timestamps,
    expiresAt: bigint("expires_at_m", { mode: "number" }),
    lastUsed: bigint("last_used_m", { mode: "number" }),
    revokedAt: bigint("revoked_at_m", { mode: "number" }),
    isRoot: boolean("is_root").notNull().default(false),
    type: text("type", { enum: API_KEY_TYPES }).notNull().default(DEFAULT_API_KEY_TYPE),
    name: text("name").notNull(),
    hash: text("hash").notNull().default(""),
    defaultCustomerId: cuid("default_customer_id"),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_apikeys",
    }),
    defaultCustomerfk: foreignKey({
      columns: [table.defaultCustomerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "apikeys_default_customer_id_fkey",
    }),
    projectCustomerIdx: index("apikeys_project_default_customer_idx")
      .on(table.projectId, table.defaultCustomerId)
      .where(sql`${table.defaultCustomerId} IS NOT NULL`),
    hash: uniqueIndex("hash").on(table.hash),
  })
)

export const apiKeysRelations = relations(apikeys, ({ one }) => ({
  project: one(projects, {
    fields: [apikeys.projectId],
    references: [projects.id],
  }),
  defaultCustomer: one(customers, {
    fields: [apikeys.defaultCustomerId, apikeys.projectId],
    references: [customers.id, customers.projectId],
  }),
}))
