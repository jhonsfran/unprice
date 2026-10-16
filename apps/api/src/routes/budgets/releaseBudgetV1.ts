import { createRoute } from "@hono/zod-openapi"
import { releaseBudgetInputSchema, releaseBudgetResponseSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/services/budgets"
import { executeBudgetCommand } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetOutcome, toWireBalance } from "./respond"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/release",
      operationId: "budgets.release",
      summary: "release a hold without consuming",
      description:
        "Return the whole hold to the budget. Releasing twice changes nothing; releasing a settled hold returns 409.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(releaseBudgetInputSchema, "The release request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(releaseBudgetResponseSchema, "The release"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "release"] },
    }
  )
)

export const registerReleaseBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "release", ...request } }
    )
    const outcome = budgetOutcome(c, result, "release")
    return c.json(
      {
        holdId: outcome.holdId,
        released: formatAmount(outcome.released),
        replayed: outcome.replayed,
        balance: toWireBalance(outcome.balance),
      },
      HttpStatusCodes.OK
    )
  })
