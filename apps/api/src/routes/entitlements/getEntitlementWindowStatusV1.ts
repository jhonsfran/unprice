import { createRoute } from "@hono/zod-openapi"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import { entitlementWindowStatusSchema } from "~/ingestion/entitlements/contracts"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["entitlementWindows"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/entitlement-windows/status",
      operationId: "entitlementWindows.status",
      summary: "inspect entitlement window operational status",
      // this endpoint is not public
      hide: true,
      description:
        "Returns a non-mutating operational status snapshot for a specific entitlement window durable object.",
      method: "get",
      tags,
      request: {
        query: z.object({
          entitlementId: z.string().openapi({
            description: "Customer entitlement id",
            example: "ce_123",
          }),
          customerId: z.string().openapi({
            description: "Customer id",
            example: "cus_123",
          }),
        }),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          entitlementWindowStatusSchema,
          "Entitlement window status"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)

export const registerGetEntitlementWindowStatusV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { entitlementId, customerId } = c.req.valid("query")
    const key = await keyAuth(c)
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    const windowClient = new CloudflareEntitlementWindowClient({
      APP_ENV: c.env.APP_ENV,
      entitlementwindow: c.env.entitlementwindow,
    })

    const stub = windowClient.getEntitlementWindowStub({
      customerEntitlementId: entitlementId,
      customerId,
      projectId,
    })

    const status = await stub.getStatus()

    return c.json(status, HttpStatusCodes.OK)
  })
