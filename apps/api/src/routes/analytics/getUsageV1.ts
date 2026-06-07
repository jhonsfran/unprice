import { createRoute } from "@hono/zod-openapi"
import {
  type FeatureUsagePeriodRow,
  analyticsIntervalSchema,
  getUsageResponseSchema,
  prepareInterval,
} from "@unprice/analytics"
import type { Currency } from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { serializeError } from "~/errors/log"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/usage/get",
  operationId: "analytics.usage.get",
  summary: "get usage",
  description: "Get usage for a customer in a given range",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customer_id: z.string().optional().openapi({
          description: "The customer ID if you want to get the usage for a specific customer",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        project_id: z
          .string()
          .openapi({
            description: "The project ID (optional, only available for main projects)",
            example: "project_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
        range: analyticsIntervalSchema.openapi({
          description: "The range of the usage, last hour, day, week or month",
          example: "24h",
        }),
      }),
      "Body of the request for the get usage"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        usage: getUsageResponseSchema.array(),
      }),
      "The result of the get usage"
    ),
    ...openApiErrorResponses,
  },
})

export type GetAnalyticsUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetAnalyticsUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

function trimInsignificantZeros(amount: string): string {
  if (!amount.includes(".")) {
    return amount
  }

  return amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
}

function formatUsageResponse(
  row: FeatureUsagePeriodRow,
  fallbackCurrency: Currency
): z.infer<typeof getUsageResponseSchema> {
  const currency = row.currency ?? fallbackCurrency
  const amount = trimInsignificantZeros(toDecimal(fromLedgerMinor(row.amount_after ?? 0, currency)))

  return {
    project_id: row.project_id,
    customer_id: row.customer_id,
    feature_slug: row.feature_slug,
    usage: row.usage ?? row.value_after ?? 0,
    spending: {
      amount,
      currency,
      display_amount: formatMoney(amount, currency),
    },
  }
}

export const registerGetAnalyticsUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customer_id: customerId, range, project_id: projectId } = c.req.valid("json")
    const analytics = c.get("analytics")
    const cache = c.get("cache")
    const logger = c.get("logger")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getUsage")

    const { start, end } = prepareInterval(range)

    // main workspace can see all usage
    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ? projectId : key.projectId) : key.projectId
    const defaultCurrency = key.project.defaultCurrency

    if (!isMain && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    const cacheKey = `${projectID}:${customerId}:${range}`

    const { err, val: data } = await cache.getUsage.swr(cacheKey, async () => {
      const rows = await analytics
        .getFeaturesUsagePeriod({
          customer_id: customerId,
          project_id: projectID,
          start,
          end,
        })
        .then((res) => res.data)
        .catch((error) => {
          const serializedError = serializeError(error)

          logger.error("analytics usage tinybird query failed", {
            error: serializedError,
            error_message: serializedError.message,
            pipe: "v1_get_feature_usage_period",
            project_id: projectID,
            customer_id: customerId,
            range,
            start,
            end,
            request_id: c.get("requestId"),
          })

          throw error
        })

      return (rows ?? []).map((row) => formatUsageResponse(row, defaultCurrency))
    })

    const usage = data ?? []

    // end the timer
    endTime(c, "getUsage")

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(
      {
        usage,
      },
      HttpStatusCodes.OK
    )
  })
