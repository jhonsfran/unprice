import { createRoute } from "@hono/zod-openapi"
import { authorizeBudgetInputSchema, authorizeBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiBudgetErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/authorize",
      operationId: "budgets.authorize",
      summary: "reserve the maximum permitted usage before work runs",
      description:
        "Reserve the maximum permitted usage against every hard limit of the budget, or return 402 with the limit that blocked it. The caller must enforce this maximum during work. Settle final usage up to the reserved amount, or release only after confirming zero usage and no continuing work. A hold still open at its expiresAt is settled at its full amount, never released. A retry with the same idempotency key and request returns the same hold; the same key with a different amount or ttlMs returns 409. A new authorization on a budget past its closesAt returns 409.",
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
    const {
      type: _,
      created,
      ...held
    } = await runBudgetVerb(c, key, { type: "authorize", ...request })
    return c.json(
      { allowed: true as const, ...toWire(held), created: created !== null },
      HttpStatusCodes.OK
    )
  })
