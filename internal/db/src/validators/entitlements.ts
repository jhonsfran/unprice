import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { featureSelectBaseSchema } from "./features"
import { configFeatureSchema, planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import {
  deniedReasonSchema,
  entitlementMergingPolicySchema,
  grantTypeSchema,
  meterConfigSchema,
  overageStrategySchema,
  resetConfigSchema,
  typeFeatureSchema,
} from "./shared"
import { subscriptionItemsSelectSchema } from "./subscriptions"

extendZodWithOpenApi(z)

export const customerEntitlementMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const entitlementMetadataSchema = z.object({
  realtime: z.boolean().optional().default(false),
  notifyUsageThreshold: z.number().int().optional().default(95),
  overageStrategy: overageStrategySchema.optional().default("none"),
  blockCustomer: z.boolean().optional().default(false),
  hidden: z.boolean().optional().default(false),
})

export const grantsMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const customerEntitlementSelectSchema = createSelectSchema(schema.customerEntitlements, {
  metadata: customerEntitlementMetadataSchema.nullable(),
  allowanceUnits: z.number().int().nonnegative().nullable(),
  overageStrategy: overageStrategySchema,
})

export const customerEntitlementInsertSchema = createInsertSchema(schema.customerEntitlements, {
  metadata: customerEntitlementMetadataSchema.nullable().optional(),
  allowanceUnits: z.number().int().nonnegative().nullable().optional(),
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
    allowanceUnits: true,
    overageStrategy: true,
    metadata: true,
  })
  .strict()

export const customerEntitlementSchemaExtended = customerEntitlementSelectSchema.extend({
  featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
    feature: featureSelectBaseSchema,
  }),
  subscriptionItem: subscriptionItemsSelectSchema.optional(),
})

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

export const grantSchemaExtended = grantSchema.extend({
  customerEntitlement: customerEntitlementSelectSchema.extend({
    featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
      feature: featureSelectBaseSchema,
    }),
  }),
})

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean()])
export const metadataSchema = z
  .record(metadataValueSchema) // Force flat key-value pairs (no deep nesting!)
  .refine((obj) => Object.keys(obj).length <= 50, {
    message: "Maximum of 50 properties allowed per event",
  })
  .refine((obj) => JSON.stringify(obj).length <= 5000, {
    message: "Properties payload too large (max 5KB)",
  })

export const reportUsageSchema = z.object({
  customerId: z.string(),
  featureSlug: z.string(),
  usage: z.number(),
  idempotenceKey: z.string(),
  timestamp: z.number(),
  projectId: z.string(),
  sync: z.boolean().optional(),
  requestId: z.string(),
  metadata: z.record(z.string(), z.any()).nullable(),
  performanceStart: z.number().optional(),
  // first-class analytics fields
  country: z.string().optional(),
  region: z.string().optional(),
  action: z.string().optional(),
  keyId: z.string().optional(),
})

export const verifySchema = z.object({
  timestamp: z.number(),
  customerId: z.string(),
  featureSlug: z.string(),
  usage: z.number().optional(), // Atomic verify + consume support
  projectId: z.string(),
  requestId: z.string(),
  metadata: z.record(z.string(), z.any()).nullable(),
  performanceStart: z.number(),
  // first-class analytics fields
  country: z.string().optional(),
  region: z.string().optional(),
  action: z.string().optional(),
  keyId: z.string().optional(),
})

export type ReportUsageRequest = z.infer<typeof reportUsageSchema>
export type VerifyRequest = z.infer<typeof verifySchema>

export const verificationResultSchema = z.object({
  allowed: z.boolean(),
  message: z.string().optional(),
  deniedReason: deniedReasonSchema.optional(),
  featureType: typeFeatureSchema.optional(),
  cacheHit: z.boolean().optional(),
  remaining: z.number().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  cost: z.number().optional(),
  latency: z.number().optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
})
export type VerificationResult = z.infer<typeof verificationResultSchema>

export const consumptionSchema = z.object({
  grantId: z.string(),
  amount: z.number(),
  priority: z.number(),
  type: z.string(),
  featurePlanVersionId: z.string(),
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
})
export type Consumption = z.infer<typeof consumptionSchema>

export const reportUsageResultSchema = z.object({
  allowed: z.boolean(),
  message: z.string().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  cost: z.number().optional(),
  notifiedOverLimit: z.boolean().optional(),
  remaining: z.number().optional(),
  deniedReason: deniedReasonSchema.optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
  cacheHit: z.boolean().optional(),
})
export type ReportUsageResult = z.infer<typeof reportUsageResultSchema>

export const entitlementGrantsSnapshotSchema = z.object({
  id: z.string(),
  type: grantTypeSchema,
  name: z.string().optional(),
  priority: z.number(),
  effectiveAt: z.number(),
  expiresAt: z.number().nullable(),
  amount: z.number().nullable().optional(),
  limit: z.number().nullable(),
  unitOfMeasure: z.string().optional(),
  featurePlanVersionId: z.string().optional(),
  config: configFeatureSchema.optional(), // Added for pricing calculations
})

export const meterStateSchema = z.object({
  lastReconciledId: z
    .string()
    .describe(
      "the last record id that was reconciled, uuidv7 id to mark the cursor position in the analytics"
    ),
  snapshotUsage: z
    .string()
    .describe(
      "snapshot of the usage in storage at the last reconciliation, we compare this with analytics to detect drift"
    ),
  lastUpdated: z.number().describe("Timestamp when the meter was last updated"),
  usage: z.string().describe("Usage in the current specific cycle"),
  lastCycleStart: z
    .number()
    .optional()
    .describe("The start timestamp of the last cycle boundary that was processed"),
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
export type MeterState = z.infer<typeof meterStateSchema>
export type CustomerEntitlement = z.infer<typeof customerEntitlementSelectSchema>
export type CustomerEntitlementExtended = z.infer<typeof customerEntitlementSchemaExtended>
export type InsertCustomerEntitlement = z.infer<typeof customerEntitlementInsertSchema>
export type Grant = z.infer<typeof grantSchema>
export type InsertGrant = z.infer<typeof grantInsertSchema>

// Runtime entitlement state used by the existing ingestion/current-usage pipeline.
// The persistent source of access is customerEntitlementSelectSchema.
export const entitlementSchema = z.object({
  id: z.string(),
  limit: z.number().nullable(),
  mergingPolicy: entitlementMergingPolicySchema,
  effectiveAt: z.number(),
  expiresAt: z.number().nullable(),
  resetConfig: resetConfigSchema
    .extend({
      resetAnchor: z.number(),
    })
    .nullable(),
  meterConfig: meterConfigSchema.nullable(),
  featureType: typeFeatureSchema,
  unitOfMeasure: z.string(),
  grants: entitlementGrantsSnapshotSchema.array(),
  featureSlug: z.string(),
  customerId: z.string(),
  projectId: z.string(),
  isCurrent: z.boolean(),
  createdAtM: z.number(),
  updatedAtM: z.number(),
  metadata: entitlementMetadataSchema.nullable(),
})

export type Entitlement = z.infer<typeof entitlementSchema>
export type EntitlementState = Entitlement & {
  meter: MeterState
}
