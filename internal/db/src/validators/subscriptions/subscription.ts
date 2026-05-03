import { Err, Ok } from "@unprice/error"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import type { Result } from "@unprice/error"
import { subscriptionPhases, subscriptions } from "../../schema/subscriptions"
import { customerSelectSchema } from "../customer"
import {
  type PlanVersionExtended,
  planVersionExtendedSchema,
  planVersionSelectBaseSchema,
} from "../planVersions"
import { planSelectBaseSchema } from "../plans"
import { projectSelectBaseSchema } from "../project"
import { UnPriceCalculationError } from "./../errors"
import { configPackageSchema } from "./../planVersionFeatures"
import { paymentProviderSchema, subscriptionStatusSchema } from "./../shared"
import {
  type SubscriptionItem,
  type SubscriptionItemConfig,
  subscriptionItemExtendedSchema,
  subscriptionItemsConfigSchema,
  subscriptionItemsSelectSchema,
} from "./items"

const reasonSchema = z.enum([
  "payment_failed",
  "invoice_voided",
  "payment_pending",
  "payment_method_not_found",
  "policy_violation",
  "pending_cancellation",
  "invoice_failed",
  "invoice_pending",
  "payment_received",
  "pending_change",
  "pending_expiration",
  "trial_ended",
  "user_requested",
  "admin_requested",
  "ending",
  "renewed",
  "cancelled",
  "auto_renew_disabled",
  "customer_signout",
  "generate_billing_periods_failed",
])

export const invoiceMetadataSchema = z.object({
  note: z.string().optional().describe("Note about the invoice"),
  reason: reasonSchema.optional().describe("Reason for the invoice"),
  credits: z.string().optional().describe("Credits applied to the invoice"),
  finalizeAttempts: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Number of times the finalize cron has attempted to push this invoice to the provider"
    ),
  lastFinalizeError: z
    .string()
    .optional()
    .describe("Last error message from the finalize cron — operator-visible only"),
  lastFinalizeAttemptAt: z
    .number()
    .int()
    .optional()
    .describe("Epoch ms timestamp of the last finalize attempt"),
  // Idempotency markers for the webhook → subscription reconcile step. Set
  // by `applyWebhookEvent` after `reconcilePaymentOutcome` succeeds so that
  // a webhook retry which arrives after the invoice has already transitioned
  // to its terminal status can skip the subscription state-machine call
  // instead of replaying it (replay would re-fire side effects like
  // `renewing` at end-of-cycle). Outcome is recorded so a later
  // payment.reversed / payment.dispute_reversed flips the marker and the
  // machine sees the new transition.
  subscriptionReconciledAt: z
    .number()
    .int()
    .optional()
    .describe("Epoch ms timestamp of the last successful reconcile against the subscription"),
  subscriptionReconciledOutcome: z
    .enum(["success", "failure"])
    .optional()
    .describe("Outcome of the last successful reconcile against the subscription"),
})

export const subscriptionMetadataSchema = z.object({
  reason: reasonSchema.optional().describe("Reason for the subscription status"),
  note: z.string().optional().describe("Note about status in the subscription"),
  dates: z
    .object({
      lastChangeAt: z.number().optional().describe("Date of the last change").optional(),
      cancelAt: z.number().optional().describe("Date of the cancellation").optional(),
    })
    .optional()
    .describe("Important dates for the subscription"),
})

export const subscriptionPhaseMetadataSchema = z.object({
  note: z.string().optional().describe("Note about the subscription phase"),
  reason: reasonSchema.optional().describe("Reason for the subscription phase"),
})

export const subscriptionSelectSchema = createSelectSchema(subscriptions, {
  metadata: subscriptionMetadataSchema,
  timezone: z.string().min(1),
  status: subscriptionStatusSchema,
  planSlug: z.string().min(1),
})

export const subscriptionPhaseSelectSchema = createSelectSchema(subscriptionPhases, {
  planVersionId: z.string().min(1, { message: "Plan version is required" }),
  paymentProvider: paymentProviderSchema,
  trialUnits: z.coerce.number().int().min(0).default(0),
  metadata: subscriptionPhaseMetadataSchema,
})
  .extend({
    items: subscriptionItemsSelectSchema.array().optional(),
  })
  .partial({
    createdAtM: true,
    updatedAtM: true,
    metadata: true,
  })

export const subscriptionPhaseExtendedSchema = subscriptionPhaseSelectSchema.extend({
  items: subscriptionItemExtendedSchema.array(),
  planVersion: planVersionSelectBaseSchema.extend({
    plan: planSelectBaseSchema,
  }),
})

export const subscriptionPhaseInsertSchema = createInsertSchema(subscriptionPhases, {
  planVersionId: z.string().min(1, { message: "Plan version is required" }),
  paymentProvider: paymentProviderSchema,
  metadata: subscriptionPhaseMetadataSchema,
  trialUnits: z.coerce.number().int().min(0).default(0),
})
  .extend({
    config: subscriptionItemsConfigSchema,
    customerId: z.string(),
    paymentMethodRequired: z.boolean(),
    items: subscriptionItemsSelectSchema.array(),
  })
  .partial({
    id: true,
    customerId: true,
    paymentProvider: true,
    paymentMethodId: true,
    config: true,
    items: true,
    metadata: true,
  })
  .omit({
    createdAtM: true,
    updatedAtM: true,
    projectId: true,
  })
  .required({
    planVersionId: true,
    paymentMethodRequired: true,
    customerId: true,
  })

export const subscriptionInsertSchema = createInsertSchema(subscriptions, {
  metadata: subscriptionMetadataSchema,
  timezone: z.string().min(1),
})
  .extend({
    // when creating a subscription, we don't need the subscriptionId
    phases: subscriptionPhaseInsertSchema
      .partial({
        subscriptionId: true,
        paymentMethodId: true,
        customerId: true,
        paymentMethodRequired: true,
      })
      .array()
      .superRefine((data, ctx) => {
        // validate payment method if payment method is required
        data.forEach((phase, index) => {
          if (phase.paymentMethodRequired) {
            if (!phase.paymentMethodId) {
              return ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Payment method is required for this phase",
                path: [index, "paymentMethodId"],
              })
            }
          }

          if (phase.trialUnits) {
            if (phase.trialUnits < 0) {
              return ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Trial duration cannot be negative",
                path: [index, "trialUnits"],
              })
            }
          }
        })

        // at least one phase is required
        if (data.length === 0) {
          return ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "At least one phase is required",
          })
        }

        // start date and end date can overlap
        for (const phase of data) {
          if (phase.endAt && phase.startAt >= phase.endAt) {
            return ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Start date must be before end date",
            })
          }
        }

        // phases must be consecutive and in order
        for (let i = 0; i < data.length - 1; i++) {
          const currentPhase = data[i]
          const nextPhase = data[i + 1]

          if (currentPhase?.endAt && nextPhase?.startAt && currentPhase.endAt > nextPhase.startAt) {
            return ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Phases must be consecutive, set end date of the previous phase",
              path: [i + 1, "startAt"],
            })
          }
        }
      }),
  })
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
    currentCycleStartAt: true,
    currentCycleEndAt: true,
  })
  .required({
    customerId: true,
  })

export const subscriptionExtendedSchema = subscriptionSelectSchema
  .pick({
    id: true,
    customerId: true,
    metadata: true,
  })
  .extend({
    planVersion: planVersionExtendedSchema,
    features: subscriptionItemsSelectSchema.array(),
  })

export const subscriptionChangePlanSchema = subscriptionSelectSchema
  .pick({
    id: true,
    timezone: true,
    currentCycleEndAt: true,
    projectId: true,
  })
  .extend({
    planVersionId: z.string().min(1, "Plan version is required"),
    currentPlanVersionId: z.string(),
    config: subscriptionItemsConfigSchema.optional(),
    whenToChange: z.enum(["immediately", "end_of_cycle"]).optional(),
  })

export const subscriptionPhaseCacheSchema = subscriptionPhaseSelectSchema.extend({
  planVersion: planVersionSelectBaseSchema,
})

export const subscriptionCacheSchema = subscriptionSelectSchema.extend({
  project: projectSelectBaseSchema.pick({
    enabled: true,
  }),
  customer: customerSelectSchema.pick({
    active: true,
  }),
  activePhase: subscriptionPhaseCacheSchema.optional(),
})

export type Subscription = z.infer<typeof subscriptionSelectSchema>
export type InsertSubscription = z.infer<typeof subscriptionInsertSchema>
export type SubscriptionExtended = z.infer<typeof subscriptionExtendedSchema>
export type InsertSubscriptionPhase = z.infer<typeof subscriptionPhaseInsertSchema>
export type SubscriptionPhase = z.infer<typeof subscriptionPhaseSelectSchema>
export type SubscriptionPhaseExtended = z.infer<typeof subscriptionPhaseExtendedSchema>
export type SubscriptionMetadata = z.infer<typeof subscriptionMetadataSchema>
export type SubscriptionPhaseMetadata = z.infer<typeof subscriptionPhaseMetadataSchema>
export type SubscriptionChangePlan = z.infer<typeof subscriptionChangePlanSchema>
export type InvoiceMetadata = z.infer<typeof invoiceMetadataSchema>
export type SubscriptionCache = z.infer<typeof subscriptionCacheSchema>
export type SubscriptionPhaseCache = z.infer<typeof subscriptionPhaseCacheSchema>

// TODO: TEST THIS
export const createDefaultSubscriptionConfig = ({
  planVersion,
  items,
}: {
  planVersion: PlanVersionExtended
  items?: SubscriptionItem[]
}): Result<SubscriptionItemConfig[], UnPriceCalculationError> => {
  if (!planVersion.planFeatures || planVersion.planFeatures.length === 0) {
    return Err(
      new UnPriceCalculationError({
        message: "Plan version does not have any features",
      })
    )
  }

  const itemsConfig = planVersion.planFeatures.map((planFeature) => {
    switch (planFeature.featureType) {
      case "flat":
        // flat features are always 1
        return {
          featurePlanId: planFeature.id,
          featureSlug: planFeature.feature.slug,
          units: 1,
          limit: 1,
          min: 1,
        }
      case "tier": {
        return {
          featurePlanId: planFeature.id,
          featureSlug: planFeature.feature.slug,
          units:
            items?.find((item) => item.featurePlanVersionId === planFeature.id)?.units ??
            planFeature.defaultQuantity ??
            1,
          min: 1,
          limit: planFeature.limit,
        }
      }
      case "usage":
        return {
          featurePlanId: planFeature.id,
          featureSlug: planFeature.feature.slug,
          limit: planFeature.limit,
          isUsage: true,
        }

      case "package": {
        const config = configPackageSchema.parse(planFeature.config)
        return {
          featurePlanId: planFeature.id,
          featureSlug: planFeature.feature.slug,
          units:
            items?.find((item) => item.featurePlanVersionId === planFeature.id)?.units ??
            config.units,
          limit: planFeature.limit,
          min: 1,
        }
      }

      default:
        return {
          featurePlanId: planFeature.id,
          featureSlug: planFeature.feature.slug,
          units: planFeature.defaultQuantity,
          limit: planFeature.defaultQuantity,
          min: 1,
        }
    }
  })

  return Ok(itemsConfig as SubscriptionItemConfig[])
}
