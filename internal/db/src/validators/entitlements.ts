import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import { overageStrategySchema } from "./shared"

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
})

export const grantSchemaExtended = grantSchema.extend({
  customerEntitlement: customerEntitlementSelectSchema.extend({
    featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
      feature: featureSelectBaseSchema,
    }),
  }),
})

// Zod schemas for UsageDisplay
const limitTypeSchema = z.enum(["hard", "soft", "none"])

const usageBarDisplaySchema = z.object({
  current: z.number(),
  included: z.number(),
  limit: z.number().optional(),
  limitType: limitTypeSchema,
  unit: z.string(),
  notifyThreshold: z.number().optional(),
  overageStrategy: overageStrategySchema.optional(),
})

const tierDisplaySchema = z.object({
  min: z.number(),
  max: z.number().nullable(),
  pricePerUnit: z.number(),
  label: z.string().optional(),
  isActive: z.boolean(),
})

const tieredDisplaySchema = z.object({
  currentUsage: z.number(),
  billableUsage: z.number(),
  unit: z.string(),
  freeAmount: z.number(),
  tiers: z.array(tierDisplaySchema),
  currentTierLabel: z.string().optional(),
})

const billingDisplaySchema = z.object({
  billingFrequencyLabel: z.string(),
  resetFrequencyLabel: z.string(),
})

const flatFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("flat"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  enabled: z.boolean(),
  billing: billingDisplaySchema,
})

const tieredFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("tiered"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  billing: billingDisplaySchema,
  tieredDisplay: tieredDisplaySchema,
})

const usageFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("usage"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  billing: billingDisplaySchema,
  usageBar: usageBarDisplaySchema,
})

const packageFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("package"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  billing: billingDisplaySchema,
})

const featureDisplaySchema = z.discriminatedUnion("type", [
  flatFeatureDisplaySchema,
  tieredFeatureDisplaySchema,
  usageFeatureDisplaySchema,
  packageFeatureDisplaySchema,
])

const featureGroupDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  featureCount: z.number(),
  features: z.array(featureDisplaySchema),
})

const priceSummaryDisplaySchema = z.object({
  totalPrice: z.string(),
  flatTotal: z.string(),
  tieredTotal: z.string(),
  packageTotal: z.string(),
  usageTotal: z.string(),
})

export const currentUsageSchema = z.object({
  planName: z.string(),
  planDescription: z.string().optional(),
  billingPeriod: z.string(),
  billingPeriodLabel: z.string(),
  currency: z.string(),
  renewalDate: z.string().optional(),
  daysRemaining: z.number().optional(),
  groups: z.array(featureGroupDisplaySchema),
  priceSummary: priceSummaryDisplaySchema,
})

export type CurrentUsage = z.infer<typeof currentUsageSchema>
export type CustomerEntitlement = z.infer<typeof customerEntitlementSelectSchema>
export type CustomerEntitlementExtended = z.infer<typeof customerEntitlementSchemaExtended>
export type InsertCustomerEntitlement = z.infer<typeof customerEntitlementInsertSchema>
export type Grant = z.infer<typeof grantSchema>
export type InsertGrant = z.infer<typeof grantInsertSchema>
