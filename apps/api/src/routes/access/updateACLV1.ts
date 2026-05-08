import { env } from "cloudflare:workers"
import { createRoute } from "@hono/zod-openapi"
import { subscriptionStatusSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["access"]

export const route = createRoute({
  path: "/v1/access/update",
  operationId: "access.update",
  summary: "update ACL",
  description: "Update the ACL for a customer",
  method: "post",
  hide: env.NODE_ENV === "production",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        updates: z.object({
          customerUsageLimitReached: z.boolean().optional(),
          customerDisabled: z.boolean().optional(),
          subscriptionStatus: subscriptionStatusSchema.optional(),
        }),
      }),
      "The updates to the ACL"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({}), "The result of the update ACL"),
    ...openApiErrorResponses,
  },
})

export type UpdateACLRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type UpdateACLResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerUpdateACLV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // const { customerId, updates } = c.req.valid("json")

    // validate the request
    // const key = await keyAuth(c)

    // const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    // validate usage from db
    // await usagelimiter.updateAccessControlList({
    //   customerId,
    //   projectId,
    //   updates,
    // })

    return c.json({}, HttpStatusCodes.OK)
  })
