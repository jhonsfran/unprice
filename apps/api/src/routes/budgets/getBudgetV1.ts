import { createRoute } from "@hono/zod-openapi"
import { getBudgetQuerySchema, getBudgetResponseSchema } from "@unprice/db/validators"
import { executeBudgetCommand } from "@unprice/services/use-cases"
import { jsonContent } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetOutcome, toWireBudget } from "./respond"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/get",
      operationId: "budgets.get",
      summary: "get a budget and its balance",
      description: "Get the budget at a key with its limits and the current balance of each.",
      method: "get",
      tags: ["budgets"],
      request: {
        query: getBudgetQuerySchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(getBudgetResponseSchema, "The budget"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "get"] },
    }
  )
)

export const registerGetBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("query")
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "get", ...request } }
    )
    const outcome = budgetOutcome(c, result, "get")
    return c.json({ budget: toWireBudget(outcome.budget) }, HttpStatusCodes.OK)
  })
