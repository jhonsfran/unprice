import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import { creditLinePolicySchema, overageStrategySchema } from "./shared"

extendZodWithOpenApi(z)

export const customerEntitlementMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const grantsMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const customerEntitlementSelectSchema = createSelectSchema(schema.customerEntitlements, {
  metadata: customerEntitlementMetadataSchema.nullable(),
  overageStrategy: overageStrategySchema,
})

export const customerEntitlementInsertSchema = createInsertSchema(schema.customerEntitlements, {
  metadata: customerEntitlementMetadataSchema.nullable().optional(),
  overageStrategy: overageStrategySchema.optional(),
})
  .partial({
    id: true,
    createdAtM: true,
    updatedAtM: true,
    subscriptionId: true,
    subscriptionPhaseId: true,
    subscriptionItemId: true,
    expiresAt: true,
    overageStrategy: true,
    metadata: true,
  })
  .strict()

export const grantSchema = createSelectSchema(schema.grants, {
  metadata: grantsMetadataSchema.nullable(),
  allowanceUnits: z.number().int().nonnegative().nullable(),
})

export const grantInsertSchema = createInsertSchema(schema.grants, {
  metadata: grantsMetadataSchema.nullable().optional(),
  allowanceUnits: z.number().int().nonnegative().nullable().optional(),
})
  .partial({
    id: true,
    createdAtM: true,
    updatedAtM: true,
    priority: true,
    expiresAt: true,
    allowanceUnits: true,
    metadata: true,
  })
  .strict()

export const customerEntitlementSchemaExtended = customerEntitlementSelectSchema.extend({
  featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
    feature: featureSelectBaseSchema,
  }),
  grants: grantSchema.array().optional(),
  subscriptionPhase: z
    .object({
      creditLinePolicy: creditLinePolicySchema,
    })
    .nullable()
    .optional(),
})

export const grantSchemaExtended = grantSchema.extend({
  customerEntitlement: customerEntitlementSelectSchema.extend({
    featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
      feature: featureSelectBaseSchema,
    }),
  }),
})

export type CustomerEntitlement = z.infer<typeof customerEntitlementSelectSchema>
export type CustomerEntitlementExtended = z.infer<typeof customerEntitlementSchemaExtended>
export type InsertCustomerEntitlement = z.infer<typeof customerEntitlementInsertSchema>
export type Grant = z.infer<typeof grantSchema>
export type GrantExtended = z.infer<typeof grantSchemaExtended>
export type InsertGrant = z.infer<typeof grantInsertSchema>
