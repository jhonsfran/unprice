import { relations } from "drizzle-orm"
import { boolean, json, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { paymentProviderConnectionDataSchema } from "../validators/paymentConfig"
import {
  paymentProviderConnectionModeEnum,
  paymentProviderConnectionStatusEnum,
  paymentProviderConnectionTypeEnum,
  paymentProviderEnum,
} from "./enums"
import { projects } from "./projects"

export const paymentProviderConfig = pgTableProject(
  "payment_provider_config",
  {
    ...projectID,
    ...timestamps,
    active: boolean("active").notNull().default(false),
    paymentProvider: paymentProviderEnum("payment_provider").default("stripe").notNull(),
    connectionType: paymentProviderConnectionTypeEnum("connection_type")
      .notNull()
      .default("bring_your_own_key"),
    mode: paymentProviderConnectionModeEnum("mode").notNull().default("test"),
    status: paymentProviderConnectionStatusEnum("status").notNull().default("not_connected"),
    key: text("key"),
    keyIv: text("key_iv"),
    webhookSecret: text("webhook_secret"),
    webhookSecretIv: text("webhook_secret_iv"),
    externalAccountId: text("external_account_id"),
    connectionData:
      json("connection_data").$type<z.infer<typeof paymentProviderConnectionDataSchema>>(),
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
