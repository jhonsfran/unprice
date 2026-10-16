import { createRoute } from "@hono/zod-openapi"
import { authorizeBudgetInputSchema, authorizeBudgetResponseSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/services/budgets"
import { executeBudgetCommand } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiBudgetErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetOutcome, toWireBalance } from "./respond"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/authorize",
      operationId: "budgets.authorize",
      summary: "hold an amount against a budget before work runs",
      description:
        "Hold an estimate against every hard limit of the budget, or return 402 with the limit that blocked it. Settle the hold with the actual amount, or release it. A retry with the same idempotency key returns the same hold.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(authorizeBudgetInputSchema, "The authorize request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(authorizeBudgetResponseSchema, "The hold"),
        ...openApiBudgetErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "authorize"] },
    }
  )
)

export const registerAuthorizeBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "authorize", ...request } }
    )
    const outcome = budgetOutcome(c, result, "authorize")
    return c.json(
      {
        allowed: true as const,
        holdId: outcome.holdId,
        amount: formatAmount(outcome.amount),
        expiresAt: outcome.expiresAt,
        replayed: outcome.replayed,
        balance: toWireBalance(outcome.balance),
      },
      HttpStatusCodes.OK
    )
  })
