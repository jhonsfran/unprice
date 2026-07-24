import { z } from "zod"
import { eventInsertBaseSchema } from "./events"
import { featureInsertBaseSchema } from "./features"

// The paid action a user names during onboarding: a single metered feature
// priced per action. Shared verbatim between the onboarding form (client) and
// the plan-template / proof use-cases (server) so both agree on what is valid.
export const paidActionPriceSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, {
    message: "Price must be a positive amount with no more than two decimal places",
  })
  .refine((value) => Number(value) > 0 && Number(value) <= 999_999.99, {
    message: "Price must be between 0.01 and 999,999.99",
  })
  .transform((value) => Number(value).toFixed(2))

export const paidActionSchema = z.object({
  title: featureInsertBaseSchema.shape.title,
  featureSlug: featureInsertBaseSchema.shape.slug,
  eventSlug: eventInsertBaseSchema.shape.slug,
  unitOfMeasure: z.literal("action").default("action"),
  unitPrice: paidActionPriceSchema,
})

export type PaidAction = z.infer<typeof paidActionSchema>
