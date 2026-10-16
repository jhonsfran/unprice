import { createRoute } from "@hono/zod-openapi"
import { upsertBudgetInputSchema, upsertBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/upsert",
      operationId: "budgets.upsert",
      summary: "create or update a budget",
      description:
        "Create the budget at a key, or update its limits and hold settings. Sending the same definition again changes nothing. The unit cannot change after creation.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(upsertBudgetInputSchema, "The upsert request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          upsertBudgetResponseSchema,
          "The changes applied and the budget"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "upsert"] },
    }
  )
)

export const registerUpsertBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const { type: _, ...upserted } = await runBudgetVerb(c, key, { type: "upsert", ...request })
    return c.json(toWire(upserted), HttpStatusCodes.OK)
  })
