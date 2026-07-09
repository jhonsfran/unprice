import { createRoute } from "@hono/zod-openapi"
import {
  flushReservationsForInvoicing,
  flushReservationsForInvoicingInputSchema,
  flushReservationsForInvoicingOutputSchema,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["billingReservations"]

const requestSchema = flushReservationsForInvoicingInputSchema.omit({ projectId: true }).extend({
  customerId: flushReservationsForInvoicingInputSchema.shape.customerId.openapi({
    description: "Customer id",
    example: "cus_123",
  }),
  subscriptionId: flushReservationsForInvoicingInputSchema.shape.subscriptionId.openapi({
    description: "Subscription id",
    example: "sub_123",
  }),
  subscriptionPhaseId: flushReservationsForInvoicingInputSchema.shape.subscriptionPhaseId.openapi({
    description: "Subscription phase id",
    example: "phase_123",
  }),
  statementKey: flushReservationsForInvoicingInputSchema.shape.statementKey.openapi({
    description: "Statement key for the billing period",
  }),
})

const responseSchema = flushReservationsForInvoicingOutputSchema.extend({
  ok: z.literal(true),
})

export type FlushReservationsForInvoicingRequest = z.infer<typeof requestSchema>
export type FlushReservationsForInvoicingResponse = z.infer<typeof responseSchema>

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/billing-reservations/flush-for-invoicing",
      operationId: "billingReservations.flushForInvoicing",
      summary: "flush wallet reservation usage before invoicing",
      description:
        "Flushes unflushed consumed usage from active wallet reservations into the ledger for invoicing. Called by the billing service before invoice materialization.",
      method: "post",
      hide: true,
      tags,
      request: {
        body: jsonContentRequired(requestSchema, "Flush reservation request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(responseSchema, "Flush result"),
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

export const registerFlushReservationsForInvoicingV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, subscriptionId, subscriptionPhaseId, statementKey } = c.req.valid("json")
    const key = await keyAuth(c)
    const projectId = key.projectId

    const { entitlement } = c.get("services")
    const db = c.get("db")

    const result = await flushReservationsForInvoicing(
      {
        db,
        entitlementWindowClient: new CloudflareEntitlementWindowClient({
          APP_ENV: c.env.APP_ENV,
          entitlementwindow: c.env.entitlementwindow,
        }),
        runBudgetClient: new CloudflareRunBudgetClient({
          APP_ENV: c.env.APP_ENV,
          runbudget: c.env.runbudget,
        }),
        services: { entitlements: entitlement },
      },
      { customerId, projectId, statementKey, subscriptionId, subscriptionPhaseId }
    )

    if (result.err) {
      throw new UnpriceApiError({
        code: result.err.reason === "deferred" ? "CONFLICT" : "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return c.json({ ok: true, ...result.val }, HttpStatusCodes.OK)
  })
