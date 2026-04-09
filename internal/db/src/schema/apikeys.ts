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

export const apikeys = pgTableProject(
  "apikeys",
  {
    ...projectID,
    ...timestamps,
    expiresAt: bigint("expires_at_m", { mode: "number" }),
    lastUsed: bigint("last_used_m", { mode: "number" }),
    revokedAt: bigint("revoked_at_m", { mode: "number" }),
    isRoot: boolean("is_root").notNull().default(false),
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
