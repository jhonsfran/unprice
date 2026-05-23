import { createRoute } from "@hono/zod-openapi"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { entitlementWindowStatusSchema } from "~/ingestion/entitlements/EntitlementWindowDO"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["events"]

const route = createRoute({
  path: "/v1/events/entitlement-window/status",
  operationId: "events.entitlementWindowStatus",
  summary: "inspect entitlement window operational status",
  description:
    "Returns a non-mutating operational status snapshot for a specific entitlement window durable object.",
  method: "get",
  tags,
  request: {
    query: z.object({
      customerEntitlementId: z.string().openapi({
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
    [HttpStatusCodes.OK]: jsonContent(entitlementWindowStatusSchema, "Entitlement window status"),
    ...openApiErrorResponses,
  },
})

export const registerGetEntitlementWindowStatusV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerEntitlementId, customerId } = c.req.valid("query")
    const key = await keyAuth(c)
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    const windowClient = new CloudflareEntitlementWindowClient({
      APP_ENV: c.env.APP_ENV,
      entitlementwindow: c.env.entitlementwindow,
    })

    const stub = windowClient.getEntitlementWindowStub({
      customerEntitlementId,
      customerId,
      projectId,
    })

    const status = await stub.getStatus()

    return c.json(status, HttpStatusCodes.OK)
  })
