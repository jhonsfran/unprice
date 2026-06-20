import { createRoute } from "@hono/zod-openapi"
import { customerEntitlementSchemaExtended } from "@unprice/db/validators"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"

const tags = ["access"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/access/entitlements/list",
      operationId: "access.entitlements.list",
      summary: "get customer entitlements",
      description: "Get active customer entitlements with their grants",
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
          z.array(customerEntitlementSchemaExtended),
          "The result of the get customer entitlements"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "configuration",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["access", "entitlements", "list"],
      },
    }
  )
)

export type GetEntitlementsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetEntitlementsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetEntitlementsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { entitlement } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getEntitlements")

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id,
    })

    // load entitlements and their active grants from Postgres
    const { err, val: result } = await entitlement.loadCustomerEntitlementsForCache({
      customerId,
      projectId: finalProjectId,
      historicalDays: 0,
    })

    // end the timer
    endTime(c, "getEntitlements")

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(result, HttpStatusCodes.OK)
  })
