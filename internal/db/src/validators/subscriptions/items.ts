import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { subscriptionItems } from "../../schema/subscriptions"
import { featureSelectBaseSchema } from "../features"
import { planVersionFeatureSelectBaseSchema } from "../planVersionFeatures"

extendZodWithOpenApi(z)

export const subscriptionItemsSelectSchema = createSelectSchema(subscriptionItems)

export const subscriptionItemExtendedSchema = createSelectSchema(subscriptionItems).extend({
  featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
    feature: featureSelectBaseSchema,
  }),
})

export const subscriptionItemsInsertSchema = createInsertSchema(subscriptionItems, {
  // units for the item, for flat features it's always 1, usage features it's the current usage
  units: () => z.coerce.number().min(1).optional(),
})
  .partial({
    id: true,
  })
  .omit({
    createdAtM: true,
    updatedAtM: true,
    projectId: true,
  })

export const subscriptionItemConfigSchema = z.object({
  featurePlanId: z.string().openapi({
    description: "The feature plan id of the item",
    example: "feature_plan_123",
  }),
  featureSlug: z.string().openapi({
    description: "The feature slug of the item",
    example: "feature_slug_123",
  }),
  isUsage: z.boolean().optional().openapi({
    description: "if the item is a usage item",
    example: true,
  }),
  units: z.coerce.number().min(1).optional().openapi({
    description: "units of the feature the user is subscribed to",
    example: 100,
  }),
  min: z.coerce.number().optional().openapi({
    description: "minimum units of the feature the user is subscribed to",
    example: 100,
  }),
  limit: z.coerce.number().optional().openapi({
    description: "limit of the feature the user is subscribed to",
    example: 100,
  }),
})

// stripe won't allow more than 250 items in a single invoice
export const subscriptionItemsConfigSchema = z
  .array(subscriptionItemConfigSchema)
  .superRefine((items, ctx) => {
    if (items.length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total items for the subscription should be less than 50",
        path: ["."],
        fatal: true,
      })

      return
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (item?.units && item.limit && item.units > item.limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `limit is ${item.limit}`,
          path: [i, "units"],
          fatal: true,
        })

        return
      }

      if (item?.units && item.min && item.units < item.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `min is ${item.min}`,
          path: [i, "units"],
          fatal: true,
        })

        return
      }
    }

    return
  })
  .refine((items) => {
    if (items.length > 250) {
      return false
    }
    return true
  }, "Total items for the subscription should be less than 250")

export type SubscriptionItemConfig = z.infer<typeof subscriptionItemConfigSchema>
export type SubscriptionItemsConfig = z.infer<typeof subscriptionItemsConfigSchema>
export type SubscriptionItem = z.infer<typeof subscriptionItemsSelectSchema>
export type InsertSubscriptionItem = z.infer<typeof subscriptionItemsInsertSchema>
export type SubscriptionItemExtended = z.infer<typeof subscriptionItemExtendedSchema>
