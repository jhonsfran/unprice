import { relations, sql } from "drizzle-orm"
import {
  boolean,
  foreignKey,
  index,
  json,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { projectID } from "../utils/sql"

import { id, timestamps } from "../utils/fields"
import type {
  customerMetadataSchema,
  customerSessionMetadataSchema,
  stripePlanVersionSchema,
  stripeSetupSchema,
} from "../validators/customer"

import { currencyEnum } from "./enums"
import { invoices } from "./invoices"
import { projects } from "./projects"
import { subscriptions } from "./subscriptions"

export const customers = pgTableProject(
  "customers",
  {
    ...projectID,
    ...timestamps,
    email: text("email").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    externalId: text("external_id"),
    metadata: json("metadata").$type<z.infer<typeof customerMetadataSchema>>(),
    stripeCustomerId: text("stripe_customer_id"),
    active: boolean("active").notNull().default(true),
    isMain: boolean("is_main").notNull().default(false),
    // all customers will have a default currency - normally the currency of the project
    defaultCurrency: currencyEnum("default_currency").notNull().default("USD"),
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),
  },
  (table) => ({
    email: index("email").on(table.email),
    externalId: uniqueIndex("cp_external_id_idx")
      .on(table.projectId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    stripeCustomerId: uniqueIndex("customers_project_stripe_customer_id_uq")
      .on(table.projectId, table.stripeCustomerId)
      .where(sql`${table.stripeCustomerId} IS NOT NULL`),
    // improve performance when querying by customer id only
    customerId: index("customer_id").on(table.id),
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_customer",
    }),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
  })
)

// when customer are created, we need to perform a session flow to add a payment method
// this table allows us to keep track of the params we need to perform the flow
// after the payment method is added in the payment provider
export const customerSessions = pgTableProject("customer_sessions", {
  ...id,
  ...timestamps,
  customer: json("customer").notNull().$type<z.infer<typeof stripeSetupSchema>>(),
  planVersion: json("plan_version").notNull().$type<z.infer<typeof stripePlanVersionSchema>>(),
  metadata: json("metadata").$type<z.infer<typeof customerSessionMetadataSchema>>(),
})

export const customersRelations = relations(customers, ({ one, many }) => ({
  project: one(projects, {
    fields: [customers.projectId],
    references: [projects.id],
  }),
  subscriptions: many(subscriptions),
  invoices: many(invoices),
  // paymentMethods: many(customerPaymentMethods),
}))
