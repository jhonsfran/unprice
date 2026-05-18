import { relations, sql } from "drizzle-orm"
import { foreignKey, json, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"
import { projects } from "./projects"

export type WalletCommandResult = Record<string, unknown>

export const walletCommandIdempotency = pgTableProject(
  "wallet_command_idempotency",
  {
    projectId: cuid("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    command: text("command").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: json("result").$type<WalletCommandResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.projectId, table.idempotencyKey],
      name: "wallet_command_idempotency_pkey",
    }),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "wallet_command_idempotency_project_id_fkey",
    }).onDelete("cascade"),
  })
)

export const walletCommandIdempotencyRelations = relations(walletCommandIdempotency, ({ one }) => ({
  project: one(projects, {
    fields: [walletCommandIdempotency.projectId],
    references: [projects.id],
  }),
}))
