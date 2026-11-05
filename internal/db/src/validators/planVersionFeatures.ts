import { AMOUNT_PATTERN, LEDGER_SCALE } from "@unprice/money"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import * as z from "zod"
import { ZodError } from "zod"

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { planVersionFeatures } from "../schema/planVersionFeatures"
import { FEATURE_TYPES_MAPS, USAGE_MODES_MAP } from "../utils"
import { featureSelectBaseSchema } from "./features"
import {
  billingConfigSchema,
  featureConfigType,
  meterConfigSchema,
  overageStrategySchema,
  resetConfigSchema,
  typeFeatureSchema,
  unitSchema,
  usageModeSchema,
} from "./shared"

extendZodWithOpenApi(z)

/**
 * A decimal price string at the ledger scale (8 places). The monetization boundary writes prices
 * in this form; they land on the plan version's rate card, never on the plan feature.
 */
export const priceSchema = z.coerce
  .string()
  .regex(
    new RegExp(`^\\d{1,8}(\\.\\d{1,${LEDGER_SCALE}})?$`),
    `Invalid price format: up to 8 digits before the decimal and up to ${LEDGER_SCALE} after (ledger precision)`
  )
  .describe(
    `Price value as a decimal string. Up to 8 digits before the decimal point and up to ${LEDGER_SCALE} after (matches ledger scale). Examples: '9.99', '100', '0.50', '1234.56', '0.00000003'`
  )

/**
 * Units of a usage feature free per statement period (ADR-0008 D5), a non-negative decimal string;
 * null when nothing is included. Rating charges price(max(0, total - included)).
 */
export const includedUnitsSchema = z
  .string()
  .regex(AMOUNT_PATTERN, "a non-negative decimal string with at most 8 decimal places")
  .nullable()
  .describe(
    "Units free per statement period. Usage up to this quantity costs nothing; the rate card prices the rest. Only for usage features whose meter has no dimensions. Example: '1000'"
  )

export const planVersionFeatureMetadataSchema = z
  .object({
    realtime: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Whether usage should be tracked and verified in real-time. When true, usage checks happen synchronously. Default: false"
      ),
    notifyUsageThreshold: z
      .number()
      .int()
      .optional()
      .default(95)
      .describe(
        "Percentage threshold (0-100) at which to notify the customer about approaching usage limits. Default: 95 (notify at 95% usage)"
      ),
    overageStrategy: overageStrategySchema
      .optional()
      .default("none")
      .describe(
        "How to handle usage that exceeds the feature limit. Options: 'none' (strict deny), 'last-call' (allow one final call while tokens remain), 'always' (allow and record overage)"
      ),
    blockCustomer: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Whether to completely block the customer when they exceed their limit. When true, access is denied until the next billing period. Default: false"
      ),
    hidden: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Whether to hide this feature from customer-facing displays like pricing pages. Useful for internal or technical features. Default: false"
      ),
    billingCadenceOverride: z
      .boolean()
      .optional()
      .describe(
        "Whether this usage feature intentionally uses a billing cadence different from the parent plan. Default: false"
      ),
    resetCadenceOverride: z
      .boolean()
      .optional()
      .describe(
        "Whether this usage feature intentionally uses a reset cadence different from its billing cadence. Default: false"
      ),
  })
  .describe(
    "Additional configuration options controlling feature behavior, notifications, and visibility"
  )

/**
 * How a plan feature is counted and sold. Its price lives on the plan version's rate card
 * (ADR-0008 D2), so a feature carries no price, tiers, or currency.
 */
export const configFlatSchema = z
  .object({})
  .describe("Flat features need no configuration; the rate card prices them")

export const configTierSchema = z
  .object({})
  .describe("Tier features need no configuration; the rate card holds their tiers")

export const configUsageSchema = z
  .object({
    usageMode: usageModeSchema.describe(
      "How usage is sold: 'unit', 'tier' (graduated), or 'package'. The rate card holds the price"
    ),
    units: unitSchema
      .optional()
      .describe("Units in a package when usageMode is 'package'. Example: 100"),
  })
  .describe("Configuration for a usage-based feature")

export const configPackageSchema = z
  .object({
    units: unitSchema.describe(
      "Number of units in each package. Example: 100 means each package includes 100 units"
    ),
  })
  .describe("Configuration for a package feature: the bundle size the rate card prices")

/** Every key any feature type uses; `validatePlanVersionFeatureMutation` checks one per type. */
export const configFeatureSchema = z
  .object({
    usageMode: usageModeSchema.optional(),
    units: unitSchema.optional(),
  })
  .describe(
    "Feature configuration. 'usage' needs usageMode, 'package' needs units, 'flat' and 'tier' need nothing. Prices live on the plan version's rate card"
  )

export type ConfigFeatureVersionType = z.infer<typeof configFeatureSchema>

// TODO: use discriminated union
export const planVersionFeatureSelectBaseSchema = createSelectSchema(planVersionFeatures, {
  config: () =>
    configFeatureSchema.describe(
      "Pricing configuration for this feature. Structure depends on featureType"
    ),
  meterConfig: () =>
    meterConfigSchema
      .nullable()
      .optional()
      .describe(
        "Snapshotted event-native meter configuration for this plan version feature. When present, it is the authoritative source for how usage should be measured"
      ),
  resetConfig: () =>
    resetConfigSchema
      .optional()
      .describe(
        "Configuration for resetting usage counters. Defines when and how usage limits reset (e.g., monthly, yearly)"
      ),
  metadata: () =>
    planVersionFeatureMetadataSchema.describe(
      "Additional feature settings including real-time tracking, notifications, and visibility options"
    ),
  defaultQuantity: () =>
    z.coerce
      .number()
      .int()
      .optional()
      .default(1)
      .describe(
        "Default quantity of this feature included when a customer subscribes. Example: 5 for '5 team members included'. Default: 1"
      ),
  limit: () =>
    z.coerce
      .number()
      .int()
      .optional()
      .describe(
        "Maximum allowed usage for this feature per billing period. Null or undefined means unlimited. Example: 10000 for 10,000 API calls/month"
      ),
  featureType: () =>
    typeFeatureSchema.describe(
      "The pricing model type: 'flat' (fixed price), 'tier' (graduated tiers), 'usage' (pay-as-you-go), or 'package' (bundle pricing)"
    ),
  unitOfMeasure: () =>
    z
      .string()
      .describe(
        "Unit of measurement captured for this plan version feature. Used for display and billing context without relying on mutable feature definitions"
      ),
  billingConfig: () =>
    billingConfigSchema.describe(
      "Billing cycle configuration including interval (month/year), billing anchor date, and plan type (recurring/onetime)"
    ),
  included: () => includedUnitsSchema,
})

const planVersionFeatureMutationBaseObject = createInsertSchema(planVersionFeatures, {
  config: () =>
    configFeatureSchema
      .optional()
      .describe(
        "Pricing configuration for this feature. Required structure depends on featureType. See configFlatSchema, configTierSchema, configUsageSchema, or configPackageSchema"
      ),
  meterConfig: () =>
    meterConfigSchema
      .nullable()
      .optional()
      .describe(
        "Optional event-native meter configuration snapshot. Allowed only for usage features and treated as the authoritative usage measurement configuration when present"
      ),
  metadata: () =>
    planVersionFeatureMetadataSchema
      .optional()
      .describe(
        "Optional additional settings for the feature including real-time tracking, usage notifications, overage handling, and visibility"
      ),
  billingConfig: () =>
    billingConfigSchema.describe(
      "Required billing cycle settings: billingInterval ('month', 'year', 'week', 'day'), billingIntervalCount, billingAnchor, and planType ('recurring', 'onetime')"
    ),
  resetConfig: () =>
    resetConfigSchema
      .optional()
      .describe(
        "Optional configuration for when usage counters reset. Useful for features with usage limits that refresh periodically"
      ),
  unitOfMeasure: () =>
    z
      .string()
      .optional()
      .describe("Unit of measurement snapshot for this plan version feature. Defaults to 'units'"),
  defaultQuantity: () =>
    z.coerce
      .number()
      .int()
      .describe(
        "Default quantity included with subscription. Must be a positive integer. Example: 5 for '5 seats included'"
      )
      .optional(),
  limit: () =>
    z.coerce
      .number()
      .int()
      .optional()
      .describe(
        "Maximum usage allowed per billing period. Leave undefined for unlimited. Example: 10000 for max 10,000 API calls"
      ),
  included: () => includedUnitsSchema.optional(),
  type: () =>
    featureConfigType
      .optional()
      .describe(
        "Feature configuration type for categorization. Options vary based on system configuration"
      ),
}).omit({
  createdAtM: true,
  updatedAtM: true,
})

const normalizePlanVersionFeatureMutation = <
  T extends {
    featureType?: z.infer<typeof typeFeatureSchema>
    config?: z.infer<typeof configFeatureSchema>
  },
>(
  data: T
) => {
  if (data.config && data.featureType) {
    // keep only the keys the feature type uses
    switch (data.featureType) {
      case FEATURE_TYPES_MAPS.flat.code:
      case FEATURE_TYPES_MAPS.tier.code:
        data.config = {}
        return data
      case FEATURE_TYPES_MAPS.package.code:
        data.config = { units: data.config.units }
        return data
      case FEATURE_TYPES_MAPS.usage.code:
        data.config = {
          usageMode: data.config.usageMode,
          ...(data.config.usageMode === USAGE_MODES_MAP.package.code && data.config.units
            ? { units: data.config.units }
            : {}),
        }
        return data
      default:
        throw new Error("Feature type not supported")
    }
  }

  return data
}

const validatePlanVersionFeatureMutation = ({
  data,
  ctx,
  validateConfigWithoutFeatureType = false,
  requireMeterConfigForUsage = false,
}: {
  data: {
    featureType?: z.infer<typeof typeFeatureSchema>
    meterConfig?: z.infer<typeof meterConfigSchema> | null
    config?: z.infer<typeof configFeatureSchema>
    included?: string | null
  }
  ctx: z.RefinementCtx
  validateConfigWithoutFeatureType?: boolean
  requireMeterConfigForUsage?: boolean
}) => {
  if (data.featureType && data.featureType !== FEATURE_TYPES_MAPS.usage.code && data.meterConfig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Meter config is only supported for usage features",
      path: ["meterConfig"],
      fatal: true,
    })

    return false
  }

  // ADR-0008 D5: an allowance needs one quantity and no dimensions; across models it is a grant.
  if (data.included !== undefined && data.included !== null) {
    if (data.featureType && data.featureType !== FEATURE_TYPES_MAPS.usage.code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Included units are only supported for usage features",
        path: ["included"],
        fatal: true,
      })

      return false
    }

    if ((data.meterConfig?.groupBy?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Included units need a meter without dimensions; use a money or credit grant",
        path: ["included"],
        fatal: true,
      })

      return false
    }
  }

  if (
    requireMeterConfigForUsage &&
    data.featureType === FEATURE_TYPES_MAPS.usage.code &&
    !data.meterConfig
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Meter config is required for usage features",
      path: ["meterConfig"],
      fatal: true,
    })

    return false
  }

  try {
    if (data.config && (data.featureType || validateConfigWithoutFeatureType)) {
      switch (data.featureType) {
        case FEATURE_TYPES_MAPS.flat.code:
          configFlatSchema.parse(data.config)
          break
        case FEATURE_TYPES_MAPS.tier.code:
          configTierSchema.parse(data.config)
          break
        case FEATURE_TYPES_MAPS.package.code:
          configPackageSchema.parse(data.config)
          break
        case FEATURE_TYPES_MAPS.usage.code:
          configUsageSchema.parse(data.config)
          break
        default:
          if (validateConfigWithoutFeatureType) {
            configFeatureSchema.parse(data.config)
            break
          }

          throw new Error("Feature type not supported")
      }
    }
  } catch (err) {
    if (err instanceof ZodError) {
      err.issues.forEach((issue) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: [`config.${issue.path.join(".")}`],
          fatal: true,
        })
      })
    }

    return false
  }

  return true
}

// We avoid the use of discriminated union because of the complexity of the schema
// also zod is planning to deprecated it
// TODO: improve this when switch api is available
export const planVersionFeatureInsertBaseSchema = planVersionFeatureMutationBaseObject
  .partial({
    projectId: true,
    id: true,
    config: true,
    metadata: true,
  })
  .required({
    featureId: true,
    planVersionId: true,
    featureType: true,
    billingConfig: true,
  })
  .extend({
    aggregationMethod: z.never().optional(),
  })
  .superRefine((data, ctx) => {
    validatePlanVersionFeatureMutation({
      data,
      ctx,
      validateConfigWithoutFeatureType: true,
      requireMeterConfigForUsage: true,
    })
  })
  .transform((data) => normalizePlanVersionFeatureMutation(data))

export const planVersionFeatureUpdateBaseSchema = planVersionFeatureMutationBaseObject
  .partial({
    projectId: true,
    id: true,
    config: true,
    metadata: true,
    featureId: true,
    featureType: true,
    billingConfig: true,
    resetConfig: true,
    unitOfMeasure: true,
    defaultQuantity: true,
    limit: true,
    type: true,
    planVersionId: true,
    order: true,
    meterConfig: true,
  })
  .required({
    id: true,
    planVersionId: true,
  })
  .extend({
    aggregationMethod: z.never().optional(),
  })
  .superRefine((data, ctx) => {
    validatePlanVersionFeatureMutation({ data, ctx })
  })
  .transform((data) => normalizePlanVersionFeatureMutation(data))

export const planVersionFeatureDragDropSchema = planVersionFeatureSelectBaseSchema
  .extend({
    feature: featureSelectBaseSchema.describe(
      "The base feature definition including title, slug, unit of measure, and description"
    ),
  })
  .describe(
    "Extended plan version feature schema that includes the base feature data, used for UI drag-and-drop functionality"
  )

export type PlanVersionFeature = z.infer<typeof planVersionFeatureSelectBaseSchema>
export type PlanVersionFeatureInsert = z.infer<typeof planVersionFeatureInsertBaseSchema>
export type PlanVersionFeatureUpdate = z.infer<typeof planVersionFeatureUpdateBaseSchema>
export type PlanVersionFeatureDragDrop = z.infer<typeof planVersionFeatureDragDropSchema>
