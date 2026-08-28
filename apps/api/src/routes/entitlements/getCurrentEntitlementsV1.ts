import { createRoute } from "@hono/zod-openapi"
import {
  getCustomerCurrentEntitlements,
  getCustomerCurrentEntitlementsOutputSchema,
} from "@unprice/services/use-cases"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import {
  keyAuth,
  resolveCustomerIdForApiKeyOrThrow,
  validateIsAllowedToAccessProject,
} from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["access"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/access/entitlements/current",
      operationId: "access.entitlements.current",
      summary: "get current customer entitlements",
      description:
        "Get all active customer entitlements. Metered entitlements include live usage state from their entitlement windows.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            customerId: z.string().openapi({
              description: "The customer ID",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            }),
            projectId: z.string().optional().openapi({
              description: "The project ID. Root keys can select an allowed project.",
              example: "prj_1H7KQFLr7RepUyQBKdnvY",
            }),
          }),
          "Current customer entitlement request"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          getCustomerCurrentEntitlementsOutputSchema,
          "Current active customer entitlements"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["access", "entitlements", "current"],
      },
    }
  )
)

export type GetCurrentEntitlementsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetCurrentEntitlementsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetCurrentEntitlementsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId: inputCustomerId, projectId: inputProjectId } = c.req.valid("json")
    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: inputCustomerId,
      defaultCustomerId: key.defaultCustomerId,
    })
    const projectId = validateIsAllowedToAccessProject({
      key,
      requestedProjectId: inputProjectId ?? key.projectId,
    })
    const requestStartedAt = c.get("requestStartedAt")
    const { entitlement } = c.get("services")

    startTime(c, "getCurrentEntitlements")

    const result = await getCustomerCurrentEntitlements(
      {
        entitlements: entitlement,
        entitlementWindowClient: new CloudflareEntitlementWindowClient({
          APP_ENV: c.env.APP_ENV,
          entitlementwindow: c.env.entitlementwindow,
        }),
        logger: c.get("logger"),
        now: () => requestStartedAt,
      },
      { customerId, projectId }
    )

    endTime(c, "getCurrentEntitlements")

    if (result.err) {
      throw toUnpriceApiError(result.err)
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
