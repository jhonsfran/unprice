import { createRoute } from "@hono/zod-openapi"
import { settleBudgetInputSchema, settleBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/settle",
      operationId: "budgets.settle",
      summary: "settle a hold with the actual amount",
      description:
        "Consume the actual amount and release the rest of the hold. An actual above the hold, or a settle after the hold lapsed, is still consumed. The hold id is the idempotency key: the same amount replays, another amount returns 409. A hold retires 24 hours after it closes or lapses; settling or releasing it after that returns 409.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(settleBudgetInputSchema, "The settle request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(settleBudgetResponseSchema, "The settlement"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "settle"] },
    }
  )
)

export const registerSettleBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const { type: _, ...settled } = await runBudgetVerb(c, key, { type: "settle", ...request })
    return c.json(toWire(settled), HttpStatusCodes.OK)
  })
