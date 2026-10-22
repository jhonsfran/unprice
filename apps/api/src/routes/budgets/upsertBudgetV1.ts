import { createRoute } from "@hono/zod-openapi"
import { upsertBudgetInputSchema, upsertBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetToWire, runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/upsert",
      operationId: "budgets.upsert",
      summary: "create or update a budget",
      description:
        "Create the budget at a key, or replace its definition. Every upsert sends the whole definition: a field it leaves out takes its default, so an omitted closesAt reopens a closing budget and omitted hold TTLs return to their defaults. Sending the same definition again changes nothing. The unit cannot change after creation. A hard cap below current consumption plus outstanding reservations returns 409. A runtime key can create a budget or tighten it; raising or removing a hard limit, making it soft, or clearing or postponing closesAt needs a config key and otherwise returns 403, so whoever spends under a cap cannot lift it.",
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
    const apiKey = await keyAuth(c, { requireType: ["runtime", "config"] })
    const mayLoosen = apiKey.type === "config"
    const { changes, budget } = await runBudgetVerb(
      c,
      key,
      { type: "upsert", ...request, mayLoosen },
      apiKey
    )
    return c.json({ changes: toWire(changes), budget: budgetToWire(budget) }, HttpStatusCodes.OK)
  })
