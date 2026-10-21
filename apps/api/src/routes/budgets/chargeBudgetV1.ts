import { createRoute } from "@hono/zod-openapi"
import { chargeBudgetInputSchema, chargeBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiBudgetErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/charge",
      operationId: "budgets.charge",
      summary: "consume an amount if it fits",
      description:
        "Consume an amount in one call when it fits every hard limit, or return 402 with the limit that blocked it. For cheap work gated before it runs. A budget past its closesAt returns 409.",
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
    const {
      type: _,
      created,
      ...charged
    } = await runBudgetVerb(c, key, { type: "charge", ...request })
    return c.json(
      { allowed: true as const, ...toWire(charged), created: created !== null },
      HttpStatusCodes.OK
    )
  })
