import { not, relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  unique,
  varchar,
} from "drizzle-orm/pg-core"

import type { z } from "zod"
import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { grantsMetadataSchema } from "../validators/entitlements"
import { grantTypeEnum, overageStrategyEnum, subjectTypeEnum } from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"

// Grants are the limits and overrides that are applied to a feature plan version
// for a given subject (workspace, project, plan, plan_version, customer)
// append only
export const grants = pgTableProject(
  "grants",
  {
    ...projectID,
    ...timestamps,
    name: varchar("name", { length: 64 }).notNull(),
    // featurePlanVersionId is the id of the feature plan version that the grant is applied to
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
    // what is the source of the grant?
    type: grantTypeEnum("type").notNull(),
    subjectType: subjectTypeEnum("subject_type").notNull(),
    // id of the subject to which the grant is applied
    // when project is the subject, the subjectId is the projectId
    // all customers with that subjectId will have the grant applied
    subjectId: cuid("subject_id").notNull(),
    // priority defines the merge order higher priority will be consumed first, comes from the type of the grant
    // subscription priority 10
    // trial priority 80
    // promotion priority 90
    // manual priority 100
    priority: integer("priority").notNull().default(0),
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    // whether the grant is auto renewed or not
    // grants with auto renew true must have a subscription item id
    autoRenew: boolean("auto_renew").notNull().default(true),
    // deleted flag is used to delete a grant
    // when deleting a grant, we set the deleted flag to true and create a new one
    // this is useful to keep append only history of the grants and reproduce any entitlement state at any time
    deleted: boolean("deleted").notNull().default(false),
    // when the grant is deleted, we store the date when it was deleted
    // grants can be changed mid cycle and we need to keep the history of the changes
    deletedAt: bigint("deleted_at", { mode: "number" }),

    // ****************** overrides from plan version feature ******************
    // we have it here so we can override them if needed
    // limit is the limit of the feature that the customer is entitled to
    limit: integer("limit"),
    overageStrategy: overageStrategyEnum("overage_strategy").notNull().default("none"),
    // amount of units the grant gives to the subject
    units: integer("units"),
    // anchor is the anchor of the grant to calculate the cycle boundaries
    anchor: integer("anchor").notNull().default(0),
    // ****************** end overrides from plan version feature ******************

    metadata: json("metadata").$type<z.infer<typeof grantsMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_grant",
    }),
    // Composite index for finding active grants by subject+feature
    idxSubjectFeatureEffective: index("idx_grants_subject_feature_effective")
      .on(
        table.projectId,
        table.subjectId,
        table.subjectType,
        table.featurePlanVersionId,
        table.effectiveAt,
        table.expiresAt
      )
      .where(not(table.deleted)),
    // unique index for the grant
    uniqueGrant: unique("unique_grant")
      .on(
        table.projectId,
        table.subjectId,
        table.subjectType,
        table.featurePlanVersionId,
        table.type,
        table.effectiveAt,
        table.expiresAt
      )
      .nullsNotDistinct(),
    // Index for grant invalidation queries by featurePlanVersion
    idxFeatureVersionEffective: index("idx_grants_feature_version_effective").on(
      table.projectId,
      table.featurePlanVersionId,
      table.effectiveAt,
      table.expiresAt
    ),
    featurePlanVersionfk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "feature_plan_version_id_fkey",
    }).onDelete("no action"),
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
  featurePlanVersion: one(planVersionFeatures, {
    fields: [grants.featurePlanVersionId, grants.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
}))
