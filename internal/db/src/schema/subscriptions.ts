import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type {
  subscriptionMetadataSchema,
  subscriptionPhaseMetadataSchema,
} from "../validators/subscriptions"
import { billingPeriods } from "./billingPeriods"
import { customers } from "./customers"
import { creditLinePolicyEnum, paymentProviderEnum, subscriptionStatusEnum } from "./enums"
import { invoices } from "./invoices"
import { planVersionFeatures } from "./planVersionFeatures"
import { versions } from "./planVersions"
import { projects } from "./projects"

// subscriptions contains the information about the subscriptions of the customers to different items
// like plans, addons, etc.
// when the subscription billing cycle ends, we create a record in another table called invoices (phases) with the items of the subscription
// a customer could be subscribed to multiple items at the same time
// we calculate the entitlements of the subscription based on the items of the subscription and save them in a redis cache to avoid calculating them every time
// also we can use binmanry to store the data in a more efficient way in redis
export const subscriptions = pgTableProject(
  "subscriptions",
  {
    ...projectID,
    ...timestamps,
    // customer to get the payment info from that customer
    customerId: cuid("customers_id").notNull(),
    status: subscriptionStatusEnum("status").notNull().default("active"),

    // whether the subscription is active or not
    // normally is active if the status is active, trialing or past_due or changing
    // this simplifies the queries when we need to get the active subscriptions
    active: boolean("active").default(false).notNull(),
    // slug of the plan only for ui purposes
    planSlug: text("plan_slug").default("FREE").notNull(),
    // UI purposes only
    currentCycleStartAt: bigint("current_cycle_start_at_m", { mode: "number" }).notNull(),
    currentCycleEndAt: bigint("current_cycle_end_at_m", { mode: "number" }).notNull(),
    // this will trigger the renewal of the subscription on every change made on the phase
    renewAt: bigint("renew_at_m", { mode: "number" }),
    // when subscription is ended
    endAt: bigint("end_at_m", { mode: "number" }),
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),
    // metadata for the subscription
    metadata: json("metadata").$type<z.infer<typeof subscriptionMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "subscriptions_pkey",
    }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "subscriptions_customer_id_fkey",
    }).onDelete("cascade"),
    // project fk
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "subscriptions_project_id_fkey",
    }).onDelete("cascade"),
    // index on the renewAt
    uniqRenew: index("subscriptions_sub_renew_uq").on(table.projectId, table.renewAt),
  })
)

// every phase represents a phase of the subscription where the billing period and currency is the same
// on every change of the plan we enter a new phase so we can have a history of the changes
// also this way we can schedule future changes and so on. Only one phase can be active at the time
export const subscriptionPhases = pgTableProject(
  "subscription_phases",
  {
    ...projectID,
    ...timestamps,
    subscriptionId: cuid("subscription_id").notNull(),
    // keep the plan here but we are subcripbing in reality to the features of the plan
    planVersionId: cuid("plan_version_id").notNull(),
    // payment method id of the customer - if not set, the first payment method will be used
    paymentMethodId: text("payment_method_id"),
    paymentProvider: paymentProviderEnum("payment_provider").notNull().default("sandbox"),
    creditLinePolicy: creditLinePolicyEnum("credit_line_policy").notNull().default("uncapped"),
    creditLineAmount: bigint("credit_line_amount", { mode: "number" }),
    // trial duration units of the phase
    trialUnits: integer("trial_units").notNull().default(0),
    // billing anchor of the phase
    billingAnchor: integer("billing_anchor").notNull().default(0),
    // ************ subscription important dates ************
    // when the trial ends
    trialEndsAt: bigint("trial_ends_at_m", { mode: "number" }),
    // when the subscription starts
    startAt: bigint("start_at_m", { mode: "number" }).notNull(),
    // when the subscription ends if undefined the subscription is active and renewed every cycle depending on auto_renew flag
    endAt: bigint("end_at_m", { mode: "number" }),
    // ************ subscription important dates ************
    metadata: json("metadata").$type<z.infer<typeof subscriptionPhaseMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "subscription_phases_pkey",
    }),
    planVersionfk: foreignKey({
      columns: [table.planVersionId, table.projectId],
      foreignColumns: [versions.id, versions.projectId],
      name: "subscription_phases_plan_version_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "subscription_phases_project_id_fkey",
    }).onDelete("cascade"),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "subscription_phases_subscription_id_fkey",
    }).onDelete("cascade"),
    // phase can't overlap with other phases of the same subscription
    uniqWindow: uniqueIndex("phase_sub_window_uq").on(
      table.projectId,
      table.subscriptionId,
      table.startAt,
      table.endAt
    ),
  })
)

export const subscriptionItems = pgTableProject(
  "subscription_items",
  {
    ...projectID,
    ...timestamps,
    // how many units of the feature the user is subscribed to
    // null means the feature is usage based
    units: integer("units"),
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
    subscriptionPhaseId: cuid("subscription_phase_id").notNull(),
    subscriptionId: cuid("subscription_id").notNull(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "subscription_items_pkey",
    }),
    featurefk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "subscription_items_plan_version_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "subscription_items_project_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "subscription_items_subscription_phase_id_fkey",
    }).onDelete("cascade"),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "subscription_items_subscription_id_fkey",
    }).onDelete("cascade"),
  })
)

export const subscriptionItemRelations = relations(subscriptionItems, ({ one }) => ({
  featurePlanVersion: one(planVersionFeatures, {
    fields: [subscriptionItems.featurePlanVersionId, subscriptionItems.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [subscriptionItems.subscriptionPhaseId, subscriptionItems.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  subscription: one(subscriptions, {
    fields: [subscriptionItems.subscriptionId, subscriptionItems.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
}))

export const subscriptionRelations = relations(subscriptions, ({ one, many }) => ({
  project: one(projects, {
    fields: [subscriptions.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [subscriptions.customerId, subscriptions.projectId],
    references: [customers.id, customers.projectId],
  }),
  phases: many(subscriptionPhases),
}))

export const subscriptionPhaseRelations = relations(subscriptionPhases, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionPhases.subscriptionId, subscriptionPhases.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  invoices: many(invoices),
  periods: many(billingPeriods),
  project: one(projects, {
    fields: [subscriptionPhases.projectId],
    references: [projects.id],
  }),
  planVersion: one(versions, {
    fields: [subscriptionPhases.planVersionId, subscriptionPhases.projectId],
    references: [versions.id, versions.projectId],
  }),
  items: many(subscriptionItems),
}))
