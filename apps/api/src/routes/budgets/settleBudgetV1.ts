import { createRoute } from "@hono/zod-openapi"
import { settleBudgetInputSchema, settleBudgetResponseSchema } from "@unprice/db/validators"
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
      path: "/v1/budgets/settle",
      operationId: "budgets.settle",
      summary: "settle a hold with the actual amount",
      description:
        "Consume the actual amount and release the rest of the hold. An actual above the hold, or a settle after the hold lapsed, is still consumed. The hold id is the idempotency key: the same amount replays, another amount returns 409.",
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
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "settle", ...request } }
    )
    const outcome = budgetOutcome(c, result, "settle")
    return c.json(
      {
        holdId: outcome.holdId,
        actual: formatAmount(outcome.actual),
        covered: formatAmount(outcome.covered),
        released: formatAmount(outcome.released),
        overrun: formatAmount(outcome.overrun),
        late: outcome.late,
        expired: outcome.expired,
        crossed: [...outcome.crossed],
        replayed: outcome.replayed,
        balance: toWireBalance(outcome.balance),
      },
      HttpStatusCodes.OK
    )
  })
