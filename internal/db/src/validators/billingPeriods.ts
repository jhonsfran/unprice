import { createSelectSchema } from "drizzle-zod"
import type { z } from "zod"
import { billingPeriods } from "../schema/billingPeriods"
import { billingPeriodTypeSchema } from "./shared"
import { billingPeriodStatusSchema } from "./shared"

export const selectBillingPeriodSchema = createSelectSchema(billingPeriods, {
  status: () => billingPeriodStatusSchema,
  type: () => billingPeriodTypeSchema,
})

export type BillingPeriod = z.infer<typeof selectBillingPeriodSchema>
