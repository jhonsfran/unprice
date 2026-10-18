import { createRoute } from "@hono/zod-openapi"
import { getBudgetQuerySchema, getBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetToWire, runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/get",
      operationId: "budgets.get",
      summary: "get a budget and its balance",
      description:
        "Get the budget at a key with its limits, the current balance of each, and the last ended periods with usage of each limited window.",
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
    const { key } = c.req.valid("query")
    const { budget, history } = await runBudgetVerb(c, key, { type: "get" })
    return c.json({ budget: budgetToWire(budget), history: toWire(history) }, HttpStatusCodes.OK)
  })
