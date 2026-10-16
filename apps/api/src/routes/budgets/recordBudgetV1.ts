import { createRoute } from "@hono/zod-openapi"
import { recordBudgetInputSchema, recordBudgetResponseSchema } from "@unprice/db/validators"
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
      path: "/v1/budgets/record",
      operationId: "budgets.record",
      summary: "record usage that already happened",
      description:
        "Consume an amount for work that already ran. Never denied, so remaining can go negative.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(recordBudgetInputSchema, "The record request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(recordBudgetResponseSchema, "The record"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "record"] },
    }
  )
)

export const registerRecordBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "record", ...request } }
    )
    const outcome = budgetOutcome(c, result, "record")
    return c.json(
      {
        amount: formatAmount(outcome.amount),
        crossed: [...outcome.crossed],
        replayed: outcome.replayed,
        balance: toWireBalance(outcome.balance),
      },
      HttpStatusCodes.OK
    )
  })
