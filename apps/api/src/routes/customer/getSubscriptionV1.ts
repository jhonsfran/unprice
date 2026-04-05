import { createRoute } from "@hono/zod-openapi"
import { subscriptionCacheSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/getSubscription",
  operationId: "customers.getSubscription",
  summary: "get subscription",
  description: "Get subscription with the active phase for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z
          .string()
          .openapi({
            description: "The project ID",
            example: "prj_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      subscriptionCacheSchema,
      "The result of the get subscription"
    ),
    ...openApiErrorResponses,
  },
})

export type GetSubscriptionRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetSubscriptionResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetSubscriptionV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const requestStartedAt = c.get("requestStartedAt")
    const { customer } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id ?? "",
    })

    const { val: subscription, err } = await customer.getActiveSubscription({
      customerId,
      projectId: finalProjectId,
      now: requestStartedAt,
      opts: {
        skipCache: false,
      },
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(subscription, HttpStatusCodes.OK)
  })
