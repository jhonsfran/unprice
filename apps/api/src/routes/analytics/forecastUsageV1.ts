import { createRoute } from "@hono/zod-openapi"
import { forecastUsage, forecastUsageOutputSchema } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["analytics"]

export const forecastUsageApiRequestSchema = z.object({
  customer_id: z.string(),
  feature_slug: z.string(),
  period_key: z.string().optional(),
  horizon_days: z.number().int().min(1).max(31).optional().default(14),
})

export const route = createRoute({
  path: "/v1/analytics/forecast-usage",
  operationId: "analytics.forecastUsage",
  summary: "forecast usage",
  description: "Project customer feature usage from recent Tinybird usage aggregates.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(forecastUsageApiRequestSchema, "Forecast usage request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(forecastUsageOutputSchema, "Forecast usage response"),
    ...openApiErrorResponses,
  },
})

export type ForecastUsageApiRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ForecastUsageApiResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerForecastUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customer_id: customerId,
      feature_slug: featureSlug,
      period_key: periodKey,
      horizon_days: horizonDays,
    } = c.req.valid("json")
    const key = await keyAuth(c)
    const result = await forecastUsage(
      {
        analytics: c.get("analytics"),
      },
      {
        projectId: key.projectId,
        customerId,
        featureSlug,
        periodKey,
        horizonDays,
      }
    )

    if (result.err) {
      throw toUnpriceApiError(result.err)
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
