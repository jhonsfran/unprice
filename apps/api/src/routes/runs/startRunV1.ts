import { createRoute } from "@hono/zod-openapi"
import { runSummarySchema, startRunInputSchema } from "@unprice/db/validators"
import { startRun } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, resolveCustomerIdForApiKey } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["runs"]

export const route = createRoute({
  path: "/v1/runs",
  operationId: "runs.start",
  summary: "start a budgeted run",
  description: "Start a new budgeted run with a budget reservation against a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(startRunInputSchema, "The run configuration"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(runSummarySchema, "The budget run summary"),
    ...openApiErrorResponses,
  },
})

export const registerStartRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const key = await keyAuth(c)

    const customer = resolveCustomerIdForApiKey({
      explicitCustomerId: body.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    if (!customer.success) {
      throw new UnpriceApiError({
        code: customer.code === "customer_forbidden" ? "FORBIDDEN" : "BAD_REQUEST",
        message: customer.message,
      })
    }

    const { budgetRuns } = c.get("services")
    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await startRun(
      { services: { budgetRuns }, runBudget },
      {
        projectId: key.projectId,
        customerId: customer.customerId,
        budgetAmount: body.budgetAmount,
        currency: body.currency,
        idempotencyKey: body.idempotencyKey,
        agentId: body.agentId,
        traceId: body.traceId,
        metadata: body.metadata,
        expiresAt: body.expiresAt,
      }
    )

    if (result.err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
