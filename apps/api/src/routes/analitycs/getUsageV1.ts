import { createRoute } from "@hono/zod-openapi"
import {
  analyticsIntervalSchema,
  getUsageResponseSchema,
  prepareInterval,
} from "@unprice/analytics"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/usage",
  operationId: "analytics.getUsage",
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
export const registerGetAnalyticsUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customer_id: customerId, range, project_id: projectId } = c.req.valid("json")
    const analytics = c.get("analytics")
    const cache = c.get("cache")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getUsage")

    const { start, end } = prepareInterval(range)

    // main workspace can see all usage
    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ? projectId : key.projectId) : key.projectId

    if (!isMain && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    const cacheKey = `${projectID}:${customerId}:${range}`

    const { err, val: data } = await cache.getUsage.swr(cacheKey, async () => {
      const result = analytics
        .getFeaturesUsagePeriod({
          customer_id: customerId,
          project_id: projectID,
          start,
          end,
        })
        .then((res) => res.data)

      return result
    })

    const usage = data ?? []

    // end the timer
    endTime(c, "getUsage")

    if (err) {
      throw err
    }

    return c.json(
      {
        usage,
      },
      HttpStatusCodes.OK
    )
  })
