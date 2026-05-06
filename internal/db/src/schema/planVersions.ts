import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  json,
  primaryKey,
  text,
  varchar,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { PlanVersionMetadata } from "../validators/planVersions"
import type { BillingConfig } from "../validators/shared"
import { users } from "./auth"
import {
  collectionMethodEnum,
  currencyEnum,
  dueBehaviourEnum,
  paymentProviderEnum,
  statusPlanEnum,
  whenToBillEnum,
} from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { plans } from "./plans"
import { projects } from "./projects"
import { subscriptionPhases } from "./subscriptions"

// plan_versions are the different versions of the plan
// each version can have different features and configurations
// this allows to handle different currencies, billing periods, etc.
// the idea with versions is the user can create a new version of the plan and publish it,
// this way the customers can subscribe to the new version of the plan
// versions are immutable, once created they can't be changed, also a version is a way to iterate on the plan
// and add new features, configurations, etc. without affecting the existing customers
// this allows pricing experiments, etc.
export const versions = pgTableProject(
  "plan_versions",
  {
    ...projectID,
    ...timestamps,

    // basic information of the plan version
    planId: cuid("plan_id").notNull(),
    // description of the plan version
    description: text("description").notNull(),
    // whether this is the latest version of the plan for the given currency, payment provider, plan type, and plan id
    latest: boolean("latest").default(false),
    // title of the version, this is useful for multiple languages. eg. "Basic Plan", "Plan Basico"
    title: varchar("title", { length: 50 }).notNull(),
    // tags for the plan, this could be used for filtering - we don't use metadata to save this
    // because we want to improve the search performance, and searching in metadata is not efficient
    tags: json("tags").$type<string[]>(),

    // handling status of the plan version
    // active: whether the plan version is active or not, if not active, it won't be available for purchase
    active: boolean("active").default(true),

    // status of the plan version - draft, published
    status: statusPlanEnum("plan_version_status").default("draft"),
    // date when the plan version was published
    publishedAt: bigint("published_at_m", { mode: "number" }),
    // user that published the plan version
    publishedBy: cuid("published_by").references(() => users.id),
    // the customers have been migrated to a new version
    archived: boolean("archived").default(false),
    archivedAt: bigint("archived_at_m", { mode: "number" }),
    archivedBy: cuid("archived_by").references(() => users.id),

    // payment provider for the plan - stripe, paypal, lemonsquezee etc.
    paymentProvider: paymentProviderEnum("payment_providers").notNull(),

    // due behaviour for the phase - cancel or downgrade
    dueBehaviour: dueBehaviourEnum("due_behaviour").default("cancel").notNull(),

    // currency of the plan
    currency: currencyEnum("currency").notNull(),

    // billing config for the plan
    billingConfig: json("billing_config").$type<BillingConfig>().notNull(),

    // ************ billing data defaults ************
    // whenToBill: pay_in_advance - pay_in_arrear
    whenToBill: whenToBillEnum("when_to_bill").notNull().default("pay_in_advance"),
    // used for generating invoices -
    gracePeriod: integer("grace_period").notNull().default(0), // 0 means no grace period to pay the invoice
    // collection method for the subscription - charge_automatically or send_invoice
    collectionMethod: collectionMethodEnum("collection_method")
      .notNull()
      .default("charge_automatically"),
    trialUnits: integer("trial_units").notNull().default(0),
    // auto renew the subscription every billing period
    autoRenew: boolean("auto_renew").notNull().default(true),
    // ************ billing data defaults ************

    // metadata probably will be useful to save external data, etc.
    metadata: json("metadata").$type<PlanVersionMetadata>(),
    paymentMethodRequired: boolean("payment_method_required").default(false).notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => ({
    planfk: foreignKey({
      columns: [table.planId, table.projectId],
      foreignColumns: [plans.id, plans.projectId],
      name: "plan_versions_plan_id_pkey",
    }).onDelete("cascade"),
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "plan_versions_plan_id_fkey",
    }),
  })
)

export const versionRelations = relations(versions, ({ one, many }) => ({
  project: one(projects, {
    fields: [versions.projectId],
    references: [projects.id],
  }),
  plan: one(plans, {
    fields: [versions.planId],
    references: [plans.id],
  }),
  planFeatures: many(planVersionFeatures),
  phases: many(subscriptionPhases),
}))
