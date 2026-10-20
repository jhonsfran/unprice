import { createRoute } from "@hono/zod-openapi"
import { inspectBudgetRequestSchema, inspectBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetToWire, inspectBudget, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/budgets/inspect",
      operationId: "budgets.internalInspect",
      summary: "inspect a budget for the dashboard",
      description:
        "The budget's snapshot and history, the open reservations that expire next, the rows closed in the last hour, and optionally one row found by id or key and an amount probed against the authorize rule. Called by the dashboard with a main-project key, for any project.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(inspectBudgetRequestSchema, "The budget and what to inspect"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(inspectBudgetResponseSchema, "The inspection"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: { expose: false },
      sdk: false,
    }
  )
)

export const registerInspectBudgetInternalV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // `internalKeyAuth` admits only main and internal keys, so the project comes from the body.
    const { projectId, key, ...query } = c.req.valid("json")
    const { budget, ...inspection } = await inspectBudget(c, { projectId, key }, query)
    return c.json({ ...toWire(inspection), budget: budgetToWire(budget) }, HttpStatusCodes.OK)
  })
