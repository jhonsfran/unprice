import { LEDGER_SCALE } from "@unprice/money"
import { dinero } from "dinero.js"
import * as currencies from "dinero.js/currencies"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import * as z from "zod"
import { ZodError } from "zod"

import { extendZodWithOpenApi } from "zod-openapi"
import { planVersionFeatures } from "../schema/planVersionFeatures"
import { FEATURE_TYPES_MAPS, USAGE_MODES_MAP } from "../utils"
import { featureSelectBaseSchema } from "./features"
import {
  billingConfigSchema,
  featureConfigType,
  meterConfigSchema,
  overageStrategySchema,
  resetConfigSchema,
  tierModeSchema,
  typeFeatureSchema,
  unitSchema,
  usageModeSchema,
} from "./shared"

extendZodWithOpenApi(z)

// Prices are validated against the ledger scale (LEDGER_SCALE = 8 decimal
// places) on both ends: finer fractions would be silently truncated by the
// ledger's numeric column, and a pre-decimal limit keeps the max encodable
// minor-unit amount (10^8 × 10^8 = 10^16) safely below `Number.MAX_SAFE_INTEGER`
// (~9.007 × 10^15). Single prices >$99,999,999 aren't realistic for SaaS;
// revisit if they ever are.
export const priceSchema = z.coerce
  .string()
  .regex(
    new RegExp(`^\\d{1,8}(\\.\\d{1,${LEDGER_SCALE}})?$`),
    `Invalid price format: up to 8 digits before the decimal and up to ${LEDGER_SCALE} after (ledger precision)`
  )
  .describe(
    `Price value as a decimal string. Up to 8 digits before the decimal point and up to ${LEDGER_SCALE} after (matches ledger scale). Examples: '9.99', '100', '0.50', '1234.56', '0.00000003'`
  )

export const dineroSnapshotSchema = z
  .object({
    amount: z
      .number()
      .describe(
        "The monetary amount in the smallest currency unit (e.g., cents for USD). Example: 999 represents $9.99"
      ),
    currency: z
      .object({
        code: z.string().describe("ISO 4217 currency code. Examples: 'USD', 'EUR', 'GBP'"),
        base: z
          .union([z.number(), z.number().array().readonly()])
          .describe("The base of the currency system. Usually 10 for decimal currencies"),
        exponent: z
          .number()
          .describe(
            "Number of decimal places for the currency. Example: 2 for USD (cents), 0 for JPY"
          ),
      })
      .describe("Currency configuration following ISO 4217 standards"),
    scale: z
      .number()
      .describe(
        "The precision scale for the monetary value. Determines how many decimal places are stored"
      ),
  })
  .describe("Internal representation of a monetary value using the Dinero.js library format")

export type DineroSnapshot = z.infer<typeof dineroSnapshotSchema>

export const dineroSchema = z
  .object({
    dinero: dineroSnapshotSchema.describe(
      "The internal Dinero.js representation of the price for precise calculations"
    ),
    displayAmount: priceSchema.describe(
      "Human-readable price value as a decimal string. This is the value users see and input. Example: '9.99'"
    ),
  })
  .describe(
    "Price object containing both the display value and internal monetary representation for precise currency calculations"
  )
  .transform((data, ctx) => {
    if (!data.dinero) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid dinero object",
        path: ["displayAmount"],
        fatal: true,
      })

      return z.NEVER
    }

    const priceDisplay = data.displayAmount

    // only rely on the currency code because the scale is not always the same
    const currencyDinero = currencies[data.dinero.currency.code as keyof typeof currencies]

    // recalculate the scale base on the currency
    const precision = priceDisplay.split(".")[1]?.length ?? currencyDinero.exponent

    // convert the price to the smallest unit
    const amount = Math.round(Number(priceDisplay) * 10 ** precision)

    const price = dinero({
      amount: amount,
      currency: currencyDinero,
      scale: precision,
    })

    try {
      // Cast to the unbranded snapshot shape so the zod output type stays
      // currency-agnostic. In dinero 2.0.2, `currencies[code]` is typed with
      // the full ISO union, which leaks into `.toJSON()` and would narrow
      // every downstream consumer (CalculatedPrice, test fixtures, etc.).
      return {
        dinero: price.toJSON() as z.infer<typeof dineroSnapshotSchema>,
        displayAmount: priceDisplay,
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid dinero object",
        path: ["displayAmount"],
        fatal: true,
      })

      return z.NEVER
    }
  })

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
  })
  .describe(
    "Additional configuration options controlling feature behavior, notifications, and visibility"
  )

export const tiersSchema = z
  .object({
    unitPrice: dineroSchema.describe(
      "Price charged per unit within this tier. Example: $0.10 per API call in the 1-1000 calls tier"
    ),
    flatPrice: dineroSchema.describe(
      "Fixed price charged for entering this tier, regardless of units consumed. Example: $50 base fee for the 'Pro' tier"
    ),
    firstUnit: z.coerce
      .number()
      .int()
      .min(1)
      .describe(
        "The starting unit number for this tier (inclusive). Must be 1 for the first tier, and consecutive with previous tier's lastUnit + 1 for subsequent tiers"
      ),
    lastUnit: z.coerce
      .number()
      .int()
      .min(1)
      .nullable()
      .describe(
        "The ending unit number for this tier (inclusive). Set to null for the final tier to indicate unlimited. Example: 1000 means this tier covers up to 1000 units"
      ),
    label: z
      .string()
      .optional()
      .describe(
        "Display name for this tier shown in pricing UI. Examples: 'Starter', 'Growth', 'Enterprise', '1-100 units'"
      ),
  })
  .describe("Configuration for a single pricing tier defining unit ranges and associated pricing")

export const configTierSchema = z
  .object({
    price: dineroSchema
      .optional()
      .describe("Base price for the feature. Not typically used in tier pricing mode"),
    tierMode: tierModeSchema.describe(
      "How tier pricing is calculated: 'volume' (all units priced at the tier they fall into) or 'graduated' (each unit priced at its respective tier)"
    ),
    tiers: z
      .array(tiersSchema)
      .describe(
        "Array of pricing tiers defining price brackets. Tiers must be consecutive (no gaps or overlaps). The last tier's lastUnit should be null for unlimited"
      ),
    usageMode: usageModeSchema
      .optional()
      .describe("Usage calculation mode. Not typically used in tier-type features"),
    units: unitSchema
      .optional()
      .describe("Number of units included. Not typically used in tier-type features"),
  })
  .describe(
    "Configuration for tier-based pricing where different price rates apply to different volume ranges"
  )
  .superRefine((data, ctx) => {
    const tiers = data.tiers

    for (let i = 0; i < tiers.length; i++) {
      if (i > 0) {
        const currentFirstUnit = tiers[i]?.firstUnit
        const previousLastUnit = tiers[i - 1]?.lastUnit

        if (!currentFirstUnit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "firstUnit needs to be defined",
            path: ["tiers", i, "firstUnit"],
            fatal: true,
          })

          return false
        }

        if (!previousLastUnit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Only the last unit of the tiers can be null",
            path: ["tiers", i - 1, "lastUnit"],
            fatal: true,
          })

          return false
        }

        if (!previousLastUnit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "lastUnit needs to be defined",
            path: ["tiers", i - 1, "lastUnit"],
            fatal: true,
          })

          return false
        }

        if (currentFirstUnit > previousLastUnit + 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Tiers need to be consecutive",
            path: ["tiers", i - 1, "lastUnit"],
            fatal: true,
          })

          return false
        }
        if (currentFirstUnit < previousLastUnit + 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Tiers cannot overlap",
            path: ["tiers", i, "firstUnit"],
            fatal: true,
          })

          return false
        }
      }
    }

    return true
  })

export const configUsageSchema = z
  .object({
    price: dineroSchema
      .optional()
      .describe(
        "Price per unit when usageMode is 'unit' or 'package'. Required for unit/package modes, not used for tier mode"
      ),
    usageMode: usageModeSchema.describe(
      "How usage is calculated and billed: 'unit' (per-unit pricing), 'tier' (volume-based tiers), or 'package' (bundle of units)"
    ),
    tierMode: tierModeSchema
      .optional()
      .describe(
        "Tier calculation method when usageMode is 'tier': 'volume' or 'graduated'. Only applicable when usageMode is 'tier'"
      ),
    tiers: z
      .array(tiersSchema)
      .optional()
      .describe(
        "Pricing tiers for tier-based usage. Required when usageMode is 'tier'. Must be consecutive with no gaps"
      ),
    units: unitSchema
      .optional()
      .describe(
        "Number of units in a package when usageMode is 'package'. Required for package mode. Example: 100 API calls per package"
      ),
  })
  .describe(
    "Configuration for usage-based (pay-as-you-go) pricing with support for per-unit, tiered, or package billing"
  )
  .superRefine((data, ctx) => {
    if (data.usageMode === USAGE_MODES_MAP.unit.code) {
      if (!data.price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Price is required when usage mode is unit",
          path: ["price"],
          fatal: true,
        })

        return false
      }
    }

    if (data.usageMode === USAGE_MODES_MAP.package.code) {
      if (!data.price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Price is required when usage mode is unit",
          path: ["price"],
          fatal: true,
        })

        return false
      }

      if (!data.units) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Units for the package is required",
          path: ["unit"],
          fatal: true,
        })

        return false
      }
    }

    if (data.usageMode === USAGE_MODES_MAP.tier.code) {
      const tiers = data.tiers

      if (!tiers || tiers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Tiers are required when usage mode is tier",
          path: ["usageMode"], // TODO: check path
          fatal: true,
        })

        return false
      }

      for (let i = 0; i < tiers.length; i++) {
        if (i > 0) {
          const currentFirstUnit = tiers[i]?.firstUnit
          const previousLastUnit = tiers[i - 1]?.lastUnit

          if (!currentFirstUnit) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "firstUnit needs to be defined",
              path: ["tiers", i, "firstUnit"],
              fatal: true,
            })

            return false
          }

          if (!previousLastUnit) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Only the last unit of the tiers can be null",
              path: ["tiers", i - 1, "lastUnit"],
              fatal: true,
            })

            return false
          }

          if (!previousLastUnit) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "lastUnit needs to be defined",
              path: ["tiers", i - 1, "lastUnit"],
              fatal: true,
            })

            return false
          }

          if (currentFirstUnit > previousLastUnit + 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Tiers need to be consecutive",
              path: ["tiers", i - 1, "lastUnit"],
              fatal: true,
            })

            return false
          }
          if (currentFirstUnit < previousLastUnit + 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Tiers cannot overlap",
              path: ["tiers", i, "firstUnit"],
              fatal: true,
            })

            return false
          }
        }
      }
    }

    return true
  })

export const configFlatSchema = z
  .object({
    tiers: z
      .array(tiersSchema)
      .optional()
      .describe("Not used for flat pricing. Will be removed during validation"),
    price: dineroSchema.describe(
      "The fixed price for this feature. This is the single price charged regardless of usage"
    ),
    usageMode: usageModeSchema
      .optional()
      .describe("Not used for flat pricing. Will be removed during validation"),
    tierMode: tierModeSchema
      .optional()
      .describe("Not used for flat pricing. Will be removed during validation"),
    units: unitSchema
      .optional()
      .describe("Not used for flat pricing. Will be removed during validation"),
  })
  .describe(
    "Configuration for flat-rate pricing where a single fixed price is charged regardless of consumption"
  )

export const configPackageSchema = z
  .object({
    tiers: z
      .array(tiersSchema)
      .optional()
      .describe("Not used for package pricing. Will be removed during validation"),
    price: dineroSchema.describe(
      "The price per package. Example: $10 per package of 100 API calls"
    ),
    usageMode: usageModeSchema
      .optional()
      .describe("Not used for package pricing. Will be removed during validation"),
    tierMode: tierModeSchema
      .optional()
      .describe("Not used for package pricing. Will be removed during validation"),
    units: unitSchema.describe(
      "Number of units included in each package. Required. Example: 100 means each package includes 100 units"
    ),
  })
  .describe(
    "Configuration for package pricing where customers purchase bundles of units at a fixed price per bundle"
  )

export const configFeatureSchema = z
  .union([configFlatSchema, configTierSchema, configUsageSchema, configPackageSchema])
  .describe(
    "Feature pricing configuration. The schema used depends on the featureType: 'flat' uses configFlatSchema, 'tier' uses configTierSchema, 'usage' uses configUsageSchema, 'package' uses configPackageSchema"
  )

export type ConfigFeatureVersionType = z.infer<typeof configFeatureSchema>

// TODO: use discriminated union
export const planVersionFeatureSelectBaseSchema = createSelectSchema(planVersionFeatures, {
  config: configFeatureSchema.describe(
    "Pricing configuration for this feature. Structure depends on featureType"
  ),
  meterConfig: meterConfigSchema
    .nullable()
    .optional()
    .describe(
      "Snapshotted event-native meter configuration for this plan version feature. When present, it is the authoritative source for how usage should be measured"
    ),
  resetConfig: resetConfigSchema
    .optional()
    .describe(
      "Configuration for resetting usage counters. Defines when and how usage limits reset (e.g., monthly, yearly)"
    ),
  metadata: planVersionFeatureMetadataSchema.describe(
    "Additional feature settings including real-time tracking, notifications, and visibility options"
  ),
  defaultQuantity: z.coerce
    .number()
    .int()
    .optional()
    .default(1)
    .describe(
      "Default quantity of this feature included when a customer subscribes. Example: 5 for '5 team members included'. Default: 1"
    ),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "Maximum allowed usage for this feature per billing period. Null or undefined means unlimited. Example: 10000 for 10,000 API calls/month"
    ),
  featureType: typeFeatureSchema.describe(
    "The pricing model type: 'flat' (fixed price), 'tier' (volume-based tiers), 'usage' (pay-as-you-go), or 'package' (bundle pricing)"
  ),
  unitOfMeasure: z
    .string()
    .describe(
      "Unit of measurement captured for this plan version feature. Used for display and billing context without relying on mutable feature definitions"
    ),
  billingConfig: billingConfigSchema.describe(
    "Billing cycle configuration including interval (month/year), billing anchor date, and plan type (recurring/onetime)"
  ),
})

export const parseFeaturesConfig = (feature: PlanVersionFeature) => {
  switch (feature.featureType) {
    case FEATURE_TYPES_MAPS.flat.code:
      return configFlatSchema.parse(feature.config)
    case FEATURE_TYPES_MAPS.tier.code:
      return configTierSchema.parse(feature.config)
    case FEATURE_TYPES_MAPS.usage.code:
      return configUsageSchema.parse(feature.config)
    default:
      throw new Error("Feature type not supported")
  }
}

const planVersionFeatureMutationBaseObject = createInsertSchema(planVersionFeatures, {
  config: configFeatureSchema
    .optional()
    .describe(
      "Pricing configuration for this feature. Required structure depends on featureType. See configFlatSchema, configTierSchema, configUsageSchema, or configPackageSchema"
    ),
  meterConfig: meterConfigSchema
    .nullable()
    .optional()
    .describe(
      "Optional event-native meter configuration snapshot. Allowed only for usage features and treated as the authoritative usage measurement configuration when present"
    ),
  metadata: planVersionFeatureMetadataSchema
    .optional()
    .describe(
      "Optional additional settings for the feature including real-time tracking, usage notifications, overage handling, and visibility"
    ),
  billingConfig: billingConfigSchema.describe(
    "Required billing cycle settings: billingInterval ('month', 'year', 'week', 'day'), billingIntervalCount, billingAnchor, and planType ('recurring', 'onetime')"
  ),
  resetConfig: resetConfigSchema
    .optional()
    .describe(
      "Optional configuration for when usage counters reset. Useful for features with usage limits that refresh periodically"
    ),
  unitOfMeasure: z
    .string()
    .default("units")
    .optional()
    .describe("Unit of measurement snapshot for this plan version feature. Defaults to 'units'"),
  defaultQuantity: z.coerce
    .number()
    .int()
    .describe(
      "Default quantity included with subscription. Must be a positive integer. Example: 5 for '5 seats included'"
    ),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "Maximum usage allowed per billing period. Leave undefined for unlimited. Example: 10000 for max 10,000 API calls"
    ),
  type: featureConfigType
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
    // remove unnecessary fields
    switch (data.featureType) {
      case FEATURE_TYPES_MAPS.flat.code:
        delete data.config.tiers
        delete data.config.tierMode
        delete data.config.usageMode
        delete data.config.units
        return data

      case FEATURE_TYPES_MAPS.package.code:
        delete data.config.usageMode
        delete data.config.tiers
        delete data.config.tierMode
        delete data.config.usageMode

        return data

      case FEATURE_TYPES_MAPS.tier.code:
        delete data.config.price
        delete data.config.usageMode
        delete data.config.units

        return data

      case FEATURE_TYPES_MAPS.usage.code:
        if (data.config.usageMode === USAGE_MODES_MAP.unit.code) {
          delete data.config.tierMode
          delete data.config.tiers
        }

        if (data.config.usageMode === USAGE_MODES_MAP.tier.code) {
          delete data.config.price
          delete data.config.units
        }

        if (data.config.usageMode === USAGE_MODES_MAP.package.code) {
          delete data.config.tierMode
          delete data.config.tiers
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
      err.errors.forEach((issue) => {
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
    return validatePlanVersionFeatureMutation({
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
    return validatePlanVersionFeatureMutation({ data, ctx })
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
