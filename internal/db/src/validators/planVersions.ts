import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import * as z from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import { versions } from "../schema/planVersions"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import { planSelectBaseSchema } from "./plans"
import { billingConfigSchema, billingIntervalSchema, currencySchema } from "./shared"

extendZodWithOpenApi(z)

export const planVersionMetadataSchema = z
  .object({
    externalId: z
      .string()
      .optional()
      .describe(
        "External identifier for integrating with third-party systems (e.g., Stripe price ID). Useful for syncing plan versions with external billing providers"
      ),
  })
  .describe(
    "Additional metadata for the plan version used for external integrations and custom data"
  )

export const insertBillingConfigSchema = billingConfigSchema
  .partial()
  .required({
    name: true,
    billingInterval: true,
    billingIntervalCount: true,
    planType: true,
  })
  .superRefine((data, ctx) => {
    // config is required for recurring plans
    if (data.planType === "recurring" && !data.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Billing interval is required for recurring plans",
        path: ["name"],
        fatal: true,
      })

      return false
    }

    // billing anchor required for recurring plans
    if (data.planType === "recurring" && !data.billingAnchor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Billing anchor is required",
        path: ["billingAnchor"],
        fatal: true,
      })

      return false
    }

    // onetime plans default to day of creation
    if (data.planType === "onetime") {
      data.billingAnchor = "dayOfCreation"
    }

    return true
  })
  .describe(
    "Billing configuration for creating a plan version. Requires: name (config name like 'monthly'), billingInterval ('month', 'year', 'week', 'day'), billingIntervalCount (number of intervals), planType ('recurring' or 'onetime'). For recurring plans, billingAnchor is also required (day of month 1-31 or 'dayOfCreation')"
  )
  .openapi({
    description: "The billing configuration for the plan version",
  })

export const planVersionSelectBaseSchema = createSelectSchema(versions, {
  tags: z
    .array(z.string())
    .describe(
      "Array of tags for categorizing and filtering plan versions. Examples: ['popular', 'recommended', 'enterprise', 'startup']"
    ),
  metadata: planVersionMetadataSchema.describe(
    "Plan version metadata containing external integration identifiers"
  ),
  currency: currencySchema.describe(
    "ISO 4217 currency code for this plan version. Examples: 'USD', 'EUR'. Each plan version is tied to a single currency"
  ),
  billingConfig: billingConfigSchema
    .describe(
      "Complete billing cycle configuration including interval, count, anchor date, and plan type"
    )
    .openapi({
      description: "The billing configuration for the plan version",
    }),
}).describe("Schema for reading/selecting plan version data from the database")

export const versionInsertBaseSchema = createInsertSchema(versions, {
  title: z
    .string()
    .describe(
      "Human-readable plan version title (1-50 chars). Will be UPPERCASED. Examples: 'Starter', 'Pro', 'Enterprise'"
    ),
  description: z.string().describe("Description of the plan version explaining what's included"),
  tags: z
    .array(z.string())
    .describe(
      "Optional tags for categorizing the plan version. Examples: ['popular', 'recommended', 'limited-time']"
    ),
  metadata: planVersionMetadataSchema.describe("Optional metadata for external integrations"),
  currency: currencySchema.describe(
    "Required. ISO 4217 currency code. Examples: 'USD', 'EUR'. Determines the currency for all pricing in this version"
  ),
  billingConfig: insertBillingConfigSchema.describe(
    "Required. Billing cycle configuration including interval, count, anchor, and plan type"
  ),
  trialUnits: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Number of trial period units (based on billing interval). Example: 14 for a 14-day trial when interval is 'day'. Default: 0 (no trial)"
    ),
  creditLineAmount: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Per-period usage allowance in pgledger scale-8 minor units (e.g. 100_000_000 = $1.00). Applies uniformly to both billing modes: the flat-features sum is the subscription fee, this is the separate usage budget. Issued as a credit_line wallet grant at activation/renewal, drained on each priced event, and settled at period end against the saved payment method (combined with the flat fee for arrears, standalone for advance). 0 disables the allowance — usage events deny with WALLET_EMPTY until the customer tops up purchased balance directly"
    ),
})
  .required({
    planId: true,
    currency: true,
    paymentProvider: true,
    paymentMethodRequired: true,
    whenToBill: true,
    billingConfig: true,
    autoRenew: true,
  })
  .partial({
    projectId: true,
    id: true,
  })
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .extend({
    isDefault: z
      .boolean()
      .optional()
      .describe(
        "Whether this is the default plan version shown to new customers. Only one version per plan should be default"
      ),
  })
  .describe(
    "Schema for creating a new plan version. Required fields: planId (parent plan), currency, paymentProvider ('stripe' or 'square'), paymentMethodRequired (boolean), whenToBill ('pay_in_arrear' or 'pay_in_advance'), billingConfig, autoRenew (boolean)"
  )

export const planVersionExtendedSchema = planVersionSelectBaseSchema
  .extend({
    planFeatures: z
      .array(
        planVersionFeatureSelectBaseSchema.extend({
          feature: featureSelectBaseSchema.describe(
            "The base feature definition with title, slug, and unit of measure"
          ),
        })
      )
      .describe(
        "Array of features included in this plan version with their pricing configurations"
      ),
  })
  .describe(
    "Extended plan version schema that includes all associated features and their configurations"
  )

export const getPlanVersionListSchema = z
  .object({
    onlyPublished: z
      .boolean()
      .optional()
      .describe(
        "When true, only returns published (active) plan versions. Published versions are visible to customers"
      )
      .openapi({
        description: "Whether to include published plan versions",
        example: true,
      }),
    onlyEnterprisePlan: z
      .boolean()
      .optional()
      .describe(
        "When true, only returns enterprise-tier plan versions. Enterprise plans typically have custom pricing"
      )
      .openapi({
        description: "Whether to include enterprise plan versions",
        example: false,
      }),
    onlyLatest: z
      .boolean()
      .optional()
      .describe(
        "When true, only returns the most recent version of each plan. Useful for showing current pricing"
      )
      .openapi({
        description: "Whether to include the latest plan version",
        example: true,
      }),
    planVersionIds: z
      .array(z.string())
      .optional()
      .describe("Filter results to specific plan version IDs. Example: ['pv_abc123', 'pv_def456']")
      .openapi({
        description: "Filter by plan version IDs",
        example: ["pv_123"],
      }),
    billingInterval: billingIntervalSchema
      .optional()
      .describe(
        "Filter by billing interval: 'month', 'year', 'week', 'day', 'minute', or 'onetime'"
      )
      .openapi({
        description: "The billing interval to filter the plan versions",
        example: "month",
      }),
    currency: currencySchema
      .optional()
      .describe("Filter by currency code. Examples: 'USD', 'EUR'")
      .openapi({
        description: "The currency to filter the plan versions",
        example: "USD",
      }),
  })
  .describe("Query parameters for filtering and listing plan versions")

export const getPlanVersionApiResponseSchema = planVersionSelectBaseSchema
  .extend({
    plan: planSelectBaseSchema
      .describe("The parent plan containing basic plan information like slug and name")
      .openapi({
        description: "The plan information",
      }),
    planFeatures: z
      .array(
        planVersionFeatureSelectBaseSchema.extend({
          displayFeatureText: z
            .string()
            .describe(
              "Pre-formatted text describing the feature for display on pricing pages. Example: '10,000 API calls/month', 'Unlimited storage'"
            )
            .openapi({
              description: "The text you can use to show the clients",
            }),
          feature: featureSelectBaseSchema
            .describe(
              "The base feature definition with title, slug, unit of measure, and description"
            )
            .openapi({
              description: "The feature information",
            }),
        })
      )
      .describe(
        "Array of features with their pricing configurations and display text for customer-facing UIs"
      ),
    flatPrice: z
      .string()
      .describe(
        "Total flat/base price of the plan as a formatted string. Sum of all flat-rate feature prices. Example: '$49.99'"
      )
      .openapi({
        description: "Flat price of the plan",
      }),
  })
  .describe(
    "Complete API response schema for a plan version including plan details, all features with display text, and calculated pricing"
  )

export type InsertPlanVersion = z.infer<typeof versionInsertBaseSchema>
export type PlanVersionMetadata = z.infer<typeof planVersionMetadataSchema>
export type PlanVersion = z.infer<typeof planVersionSelectBaseSchema>
export type InsertBillingConfig = z.infer<typeof insertBillingConfigSchema>
export type PlanVersionApi = z.infer<typeof getPlanVersionApiResponseSchema>
export type PlanVersionExtended = z.infer<typeof planVersionExtendedSchema>
