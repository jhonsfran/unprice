import { relations } from "drizzle-orm"
import { boolean, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { paymentProviderEnum } from "./enums"
import { projects } from "./projects"

export const paymentProviderConfig = pgTableProject(
  "payment_provider_config",
  {
    ...projectID,
    ...timestamps,
    active: boolean("active").notNull().default(false),
    paymentProvider: paymentProviderEnum("payment_provider").default("stripe").notNull(),
    key: text("key").notNull(),
    keyIv: text("key_iv").notNull(),
    webhookSecret: text("webhook_secret"),
    webhookSecretIv: text("webhook_secret_iv"),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_ppconfig",
    }),
    // a project can only have one config per payment provider
    unique: uniqueIndex("unique_payment_provider_config").on(
      table.paymentProvider,
      table.projectId
    ),
  })
)

export const paymentProviderConfigRelations = relations(paymentProviderConfig, ({ one }) => ({
  project: one(projects, {
    fields: [paymentProviderConfig.projectId],
    references: [projects.id],
  }),
}))
