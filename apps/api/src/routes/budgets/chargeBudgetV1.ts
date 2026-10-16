import { createRoute } from "@hono/zod-openapi"
import { chargeBudgetInputSchema, chargeBudgetResponseSchema } from "@unprice/db/validators"
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
      path: "/v1/budgets/charge",
      operationId: "budgets.charge",
      summary: "consume an amount if it fits",
      description:
        "Consume an amount in one call when it fits every hard limit, or return 402 with the limit that blocked it. For cheap work gated before it runs.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(chargeBudgetInputSchema, "The charge request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(chargeBudgetResponseSchema, "The charge"),
        ...openApiBudgetErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "charge"] },
    }
  )
)

export const registerChargeBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "charge", ...request } }
    )
    const outcome = budgetOutcome(c, result, "charge")
    return c.json(
      {
        allowed: true as const,
        amount: formatAmount(outcome.amount),
        crossed: [...outcome.crossed],
        replayed: outcome.replayed,
        balance: toWireBalance(outcome.balance),
      },
      HttpStatusCodes.OK
    )
  })
