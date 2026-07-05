import {
  subscriptionChangePlanSchema,
  subscriptionPhaseInsertSchema,
  subscriptionPhaseUpdateSchema,
} from "@unprice/db/validators"
import { z } from "zod"

export const schedulePhaseSchema = subscriptionChangePlanSchema
  .extend({
    customerId: z.string().optional(),
    startAt: z.number(),
    endAt: z.number().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMethodRequired && !data.paymentMethodId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Payment method is required for this phase",
        path: ["paymentMethodId"],
      })
    }

    addPhaseDateRangeIssue(data, ctx)
  })

export const editablePhaseSchema = subscriptionPhaseUpdateSchema.superRefine((data, ctx) => {
  addPhaseDateRangeIssue(data, ctx)
})

export const createPhaseSchema = subscriptionPhaseInsertSchema.superRefine((data, ctx) => {
  if (data.paymentMethodRequired && !data.paymentMethodId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Payment method is required for this phase",
      path: ["paymentMethodId"],
    })

    return
  }

  addPhaseDateRangeIssue(data, ctx)
})

function addPhaseDateRangeIssue(
  data: { startAt?: number; endAt?: number | null },
  ctx: z.RefinementCtx
) {
  if (typeof data.startAt !== "number" || typeof data.endAt !== "number") {
    return
  }

  if (data.endAt < data.startAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "End date must be after the phase start date",
      path: ["endAt"],
    })
  }
}
