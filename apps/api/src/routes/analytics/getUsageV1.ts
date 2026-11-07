import { createRoute } from "@hono/zod-openapi"
import {
  analyticsIntervalSchema,
  getUsageResponseSchema,
  prepareInterval,
} from "@unprice/db/validators"
import { formatAmount, formatMoney } from "@unprice/money"
import { FEATURE_SLOTS, type FeatureUsageRow, customerOfKey } from "@unprice/services/analytics"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import {
  keyAuth,
  resolveCustomerIdForApiKeyOrThrow,
  validateIsAllowedToAccessProject,
} from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { serializeError } from "~/errors/log"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"

const tags = ["analytics"]

export const route = createRoute(
  defineEndpointContract(
    {
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
            truncated_events: z
              .number()
              .int()
              .nonnegative()
              .openapi({
                description: `Events that fed more than ${FEATURE_SLOTS} features. Their features past the ${FEATURE_SLOTS}th are not in usage; 0 when every event is counted in full.`,
                example: 0,
              }),
          }),
          "The result of the get usage"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "analytics",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["analytics", "usage", "get"],
      },
    }
  )
)

export type GetAnalyticsUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetAnalyticsUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

function formatUsageResponse(
  row: FeatureUsageRow & { feature_slug: string },
  projectId: string
): z.infer<typeof getUsageResponseSchema> {
  const amount = formatAmount(row.amount)
  const customerId = row.budget_key ? customerOfKey(row.budget_key) : null
  const currency = row.unit.startsWith("money:") ? row.unit.slice("money:".length) : null

  return {
    project_id: projectId,
    ...(customerId ? { customer_id: customerId } : {}),
    feature_slug: row.feature_slug,
    usage: Number(formatAmount(row.quantity)),
    spending: {
      amount,
      currency: currency ?? "XXX",
      display_amount: currency ? formatMoney(amount, currency) : `${amount} ${row.unit}`,
    },
  }
}

export const registerGetAnalyticsUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customer_id: inputCustomerId, range, project_id: projectId } = c.req.valid("json")
    const { analytics } = c.get("services")
    const cache = c.get("cache")
    const logger = c.get("logger")

    // validate the request
    const key = await keyAuth(c)
    const customerId =
      inputCustomerId || key.defaultCustomerId
        ? resolveCustomerIdForApiKeyOrThrow({
            explicitCustomerId: inputCustomerId,
            defaultCustomerId: key.defaultCustomerId,
          })
        : undefined

    startTime(c, "getUsage")

    const { start, end } = prepareInterval(range)

    const projectID = validateIsAllowedToAccessProject({
      key,
      requestedProjectId: projectId ?? key.projectId,
    })

    const cacheKey = `journal:v2:${projectID}:${customerId}:${range}`

    // Usage history from the budget journal (ADR-0008 D7), one row per customer and feature.
    const { err, val: data } = await cache.getUsage.swr(cacheKey, async () => {
      const rows = await analytics.getFeatureUsage({
        projectId: projectID,
        customerId,
        window: { from: new Date(start), to: new Date(end) },
        byCustomer: true,
      })

      if (rows.err) {
        const serializedError = serializeError(rows.err)
        logger.error("analytics usage journal query failed", {
          error: serializedError,
          error_message: serializedError.message,
          project_id: projectID,
          customer_id: customerId,
          range,
          request_id: c.get("requestId"),
        })
        throw rows.err
      }

      // A null feature slug counts the events that fed more than FEATURE_SLOTS features.
      return {
        usage: rows.val
          .filter(
            (row): row is FeatureUsageRow & { feature_slug: string } => row.feature_slug !== null
          )
          .map((row) => formatUsageResponse(row, projectID)),
        truncated_events: rows.val
          .filter((row) => row.feature_slug === null)
          .reduce((sum, row) => sum + row.events, 0),
      }
    })

    endTime(c, "getUsage")

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(data ?? { usage: [], truncated_events: 0 }, HttpStatusCodes.OK)
  })
