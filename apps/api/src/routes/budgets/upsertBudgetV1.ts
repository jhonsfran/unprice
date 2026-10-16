import { createRoute } from "@hono/zod-openapi"
import { upsertBudgetInputSchema, upsertBudgetResponseSchema } from "@unprice/db/validators"
import { type ConfigChange, formatAmount } from "@unprice/services/budgets"
import { executeBudgetCommand } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
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
    const apiKey = await keyAuth(c)
    const result = await executeBudgetCommand(
      { budgets: new CloudflareBudgetClient(c.env) },
      { projectId: apiKey.projectId, key, request: { type: "upsert", ...request } }
    )
    const outcome = budgetOutcome(c, result, "upsert")
    return c.json(
      {
        changes: outcome.changes.map(toWireChange),
        budget: toWireBudget(outcome.budget),
      },
      HttpStatusCodes.OK
    )
  })

function toWireChange(change: ConfigChange) {
  if (!("from" in change)) return change
  const format = (value: typeof change.from) =>
    typeof value === "bigint" ? formatAmount(value) : value
  return { ...change, from: format(change.from), to: format(change.to) }
}
