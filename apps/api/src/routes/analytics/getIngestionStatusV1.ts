import { createRoute } from "@hono/zod-openapi"
import { getIngestionStatus, getIngestionStatusOutputSchema } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["analytics"]

export const getIngestionStatusApiRequestSchema = z
  .object({
    customer_id: z.string(),
    from_ts: z.number().int(),
    to_ts: z.number().int(),
    source_id: z.string().optional(),
    event_slug: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((input) => input.from_ts < input.to_ts, {
    message: "to_ts must be greater than from_ts",
    path: ["to_ts"],
  })

export const route = createRoute({
  path: "/v1/analytics/ingestion/status",
  operationId: "analytics.ingestion.status",
  summary: "get ingestion status",
  description: "Get live ingestion status for a customer in a requested window.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(getIngestionStatusApiRequestSchema, "Get ingestion status request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      getIngestionStatusOutputSchema,
      "Get ingestion status response"
    ),
    ...openApiErrorResponses,
  },
})

export type GetIngestionStatusApiRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetIngestionStatusApiResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetIngestionStatusV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customer_id: customerId,
      from_ts: fromTs,
      to_ts: toTs,
      source_id: sourceId,
      event_slug: eventSlug,
      limit,
    } = c.req.valid("json")
    const key = await keyAuth(c)

    const result = await getIngestionStatus(
      {
        analytics: c.get("analytics"),
      },
      {
        projectId: key.projectId,
        customerId,
        window: {
          from: fromTs,
          to: toTs,
        },
        filter: {
          sourceId,
          eventSlug,
        },
        limit,
      }
    )

    if (result.err) {
      throw toUnpriceApiError(result.err)
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
