import { z } from "zod"

export const intervalDaysSchema = z.number().int().min(1).max(90).optional()

export const pageVisitsInputSchema = z.object({
  page_id: z.string().optional(),
  interval_days: intervalDaysSchema,
})
