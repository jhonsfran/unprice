import { createRoute } from "@hono/zod-openapi"
import { releaseBudgetInputSchema, releaseBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/release",
      operationId: "budgets.release",
      summary: "release a hold without consuming",
      description:
        "Return the whole hold to the budget. Releasing twice changes nothing; releasing a settled hold returns 409.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(releaseBudgetInputSchema, "The release request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(releaseBudgetResponseSchema, "The release"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "release"] },
    }
  )
)

export const registerReleaseBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const { type: _, ...released } = await runBudgetVerb(c, key, { type: "release", ...request })
    return c.json(toWire(released), HttpStatusCodes.OK)
  })
