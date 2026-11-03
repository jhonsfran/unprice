import { createRoute } from "@hono/zod-openapi"
import {
  billingUsageOperationOutputSchema,
  billingUsageOperationSchema,
  processBillingUsageSnapshots,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/billing-usage/snapshots",
      operationId: "billingUsage.snapshots",
      summary: "Register, seal, or complete authoritative billing usage",
      method: "post",
      hide: true,
      tags: ["billingUsage"],
      request: {
        body: jsonContentRequired(billingUsageOperationSchema, "Billing usage operation"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          billingUsageOperationOutputSchema,
          "Billing usage snapshots"
        ),
        ...openApiErrorResponses,
      },
    },
    { audience: "internal", category: "operations", docs: { expose: false }, sdk: false }
  )
)

export const registerUsageSnapshotsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const input = c.req.valid("json")
    const result = await processBillingUsageSnapshots(
      {
        db: c.get("db"),
        entitlementWindowClient: new CloudflareEntitlementWindowClient({
          APP_ENV: c.env.APP_ENV,
          entitlementwindow: c.env.entitlementwindow,
        }),
      },
      input
    )
    if (result.err) throw new UnpriceApiError({ code: "CONFLICT", message: result.err.message })
    return c.json(result.val, HttpStatusCodes.OK)
  })
