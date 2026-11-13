import { z } from "zod"

/**
 * What a card shows when a web analytics read fails. The service logs the cause; a raw Basin
 * message (status, query detail) never reaches the browser.
 */
export const WEB_ANALYTICS_UNAVAILABLE = "Web analytics are unavailable right now"

export const intervalDaysSchema = z.number().int().min(1).max(90).optional()

export const pageVisitsInputSchema = z.object({
  page_id: z.string().optional(),
  interval_days: intervalDaysSchema,
})
