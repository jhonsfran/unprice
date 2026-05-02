import { relations } from "drizzle-orm"
import { bigint, foreignKey, index, integer, json, primaryKey, unique } from "drizzle-orm/pg-core"

import type { z } from "zod"
import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type {
  customerEntitlementMetadataSchema,
  grantsMetadataSchema,
} from "../validators/entitlements"
import { customers } from "./customers"
import { grantTypeEnum, overageStrategyEnum } from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems, subscriptionPhases, subscriptions } from "./subscriptions"

export const customerEntitlements = pgTableProject(
  "customer_entitlements",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
    subscriptionId: cuid("subscription_id"),
    subscriptionPhaseId: cuid("subscription_phase_id"),
    subscriptionItemId: cuid("subscription_item_id"),
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    overageStrategy: overageStrategyEnum("overage_strategy").notNull().default("none"),
    metadata: json("metadata").$type<z.infer<typeof customerEntitlementMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "customer_entitlements_pkey",
    }),
    idxCustomerWindow: index("idx_customer_entitlements_customer_window").on(
      table.projectId,
      table.customerId,
      table.effectiveAt,
      table.expiresAt
    ),
    idxPhaseSource: index("idx_customer_entitlements_phase_source").on(
      table.projectId,
      table.customerId,
      table.subscriptionPhaseId,
      table.featurePlanVersionId,
      table.effectiveAt,
      table.expiresAt
    ),
    uniqueSourceWindow: unique("unique_customer_entitlement_source_window")
      .on(
        table.projectId,
        table.customerId,
        table.featurePlanVersionId,
        table.subscriptionId,
        table.subscriptionPhaseId,
        table.subscriptionItemId,
        table.effectiveAt,
        table.expiresAt
      )
      .nullsNotDistinct(),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "customer_entitlements_customer_id_fkey",
    }).onDelete("cascade"),
    featurePlanVersionfk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "customer_entitlements_feature_plan_version_id_fkey",
    }).onDelete("no action"),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "customer_entitlements_subscription_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "customer_entitlements_subscription_phase_id_fkey",
    }).onDelete("cascade"),
    subscriptionItemfk: foreignKey({
      columns: [table.subscriptionItemId, table.projectId],
      foreignColumns: [subscriptionItems.id, subscriptionItems.projectId],
      name: "customer_entitlements_subscription_item_id_fkey",
    }).onDelete("cascade"),
  })
)

// Grants are append-only allowance chunks under one customer entitlement.
export const grants = pgTableProject(
  "grants",
  {
    ...projectID,
    ...timestamps,
    customerEntitlementId: cuid("customer_entitlement_id").notNull(),
    type: grantTypeEnum("type").notNull(),
    priority: integer("priority").notNull().default(0),
    allowanceUnits: integer("allowance_units"),
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    metadata: json("metadata").$type<z.infer<typeof grantsMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_grant",
    }),
    idxCustomerEntitlementEffective: index("idx_grants_customer_entitlement_effective").on(
      table.projectId,
      table.customerEntitlementId,
      table.effectiveAt,
      table.expiresAt,
      table.priority
    ),
    uniqueGrant: unique("unique_grant")
      .on(
        table.projectId,
        table.customerEntitlementId,
        table.type,
        table.effectiveAt,
        table.expiresAt
      )
      .nullsNotDistinct(),
    customerEntitlementfk: foreignKey({
      columns: [table.customerEntitlementId, table.projectId],
      foreignColumns: [customerEntitlements.id, customerEntitlements.projectId],
      name: "grants_customer_entitlement_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
  })
)

export const grantsRelations = relations(grants, ({ one }) => ({
  project: one(projects, {
    fields: [grants.projectId],
    references: [projects.id],
  }),
  customerEntitlement: one(customerEntitlements, {
    fields: [grants.customerEntitlementId, grants.projectId],
    references: [customerEntitlements.id, customerEntitlements.projectId],
  }),
}))

export const customerEntitlementsRelations = relations(customerEntitlements, ({ many, one }) => ({
  project: one(projects, {
    fields: [customerEntitlements.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [customerEntitlements.customerId, customerEntitlements.projectId],
    references: [customers.id, customers.projectId],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [customerEntitlements.featurePlanVersionId, customerEntitlements.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  subscription: one(subscriptions, {
    fields: [customerEntitlements.subscriptionId, customerEntitlements.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [customerEntitlements.subscriptionPhaseId, customerEntitlements.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  subscriptionItem: one(subscriptionItems, {
    fields: [customerEntitlements.subscriptionItemId, customerEntitlements.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
  grants: many(grants),
}))
