import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import * as z from "zod"

import * as schema from "../schema"
import { deniedReasonSchema, meterConfigSchema, typeFeatureSchema } from "./shared"

export const featureSelectBaseSchema = createSelectSchema(schema.features, {
  meterConfig: () =>
    meterConfigSchema
      .nullable()
      .optional()
      .describe(
        "Default meter template for usage-style features. When present, new plan version feature snapshots can copy this event-native measurement configuration"
      ),
})

export const featureInsertBaseSchema = createInsertSchema(schema.features, {
  title: () =>
    z
      .string()
      .min(1)
      .max(50)
      .refine((title) => /^[a-zA-Z0-9\s]+$/.test(title), {
        message: "Title must contain only letters, numbers, and spaces",
      })
      .describe(
        "Human-readable name for the feature displayed to users. Must contain only letters, numbers, and spaces. Example: 'API Calls', 'Storage GB', 'Team Members'"
      ),
  slug: () =>
    z
      .string()
      .min(1)
      .refine((slug) => /^[a-z0-9-]+$/.test(slug), {
        message: "Slug must be a valid slug",
      })
      .describe(
        "URL-friendly unique identifier for the feature. Must be lowercase with hyphens only. Used for API lookups and references. Example: 'api-calls', 'storage-gb', 'team-members'"
      ),
  unitOfMeasure: () =>
    z
      .string()
      .optional()
      .describe(
        "Unit of measurement for the feature. Describes what is being counted or measured. Examples: 'calls', 'GB', 'seats', 'tokens', 'requests', 'minutes'. Defaults to 'units' if not specified"
      ),
  description: () =>
    z
      .string()
      .optional()
      .describe(
        "Detailed explanation of what the feature provides or enables. Helps users understand the feature's purpose and value. Example: 'Number of API requests allowed per billing period'"
      ),
  meterConfig: () =>
    meterConfigSchema
      .nullable()
      .optional()
      .describe(
        "Optional default meter configuration template. This is snapshotted into plan version features when a metered feature is attached to a draft version"
      ),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
  })

export type InsertFeature = z.infer<typeof featureInsertBaseSchema>
export type Feature = z.infer<typeof featureSelectBaseSchema>

export const featureVerificationSchema = z
  .object({
    success: z
      .boolean()
      .describe(
        "Indicates whether the feature access verification was successful. True means the user has access to the feature, false means access was denied"
      ),
    deniedReason: deniedReasonSchema
      .optional()
      .describe(
        "The reason why feature access was denied when success is false. Provides specific error codes like 'LIMIT_EXCEEDED', 'ENTITLEMENT_NOT_FOUND', 'SUBSCRIPTION_EXPIRED', etc."
      ),
    currentUsage: z
      .number()
      .optional()
      .describe(
        "The current amount of the feature that has been consumed in the current billing period. Used to track progress toward limits"
      ),
    limit: z
      .number()
      .optional()
      .describe(
        "The maximum allowed usage for this feature in the current billing period. When currentUsage reaches this value, access may be denied"
      ),
    featureType: typeFeatureSchema
      .optional()
      .describe(
        "The pricing model type for this feature: 'flat' (fixed price), 'tier' (volume-based pricing tiers), 'package' (bundle pricing), or 'usage' (pay-as-you-go)"
      ),
    units: z
      .number()
      .optional()
      .describe(
        "The number of units associated with this feature verification request. Represents the quantity being checked or consumed"
      ),
    message: z
      .string()
      .optional()
      .describe(
        "Human-readable message providing additional context about the verification result. Can explain why access was granted or denied"
      ),
  })
  .describe(
    "Schema representing the result of verifying a user's access to a specific feature based on their subscription and entitlements"
  )

export type FeatureVerification = z.infer<typeof featureVerificationSchema>
