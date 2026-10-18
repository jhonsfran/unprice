import { createRoute } from "@hono/zod-openapi"
import { leaseBudgetInputSchema, leaseBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiBudgetErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/lease",
      operationId: "budgets.lease",
      summary: "debit capacity for a long-lived process to spend locally",
      description:
        "Debit capacity against every hard limit before it is spent, for a long-lived process to authorize, settle, and charge in its own memory. Near a limit less than asked for is granted; when nothing fits, 402. Report usage to /v1/budgets/report before expiresAt, or the whole grant counts as used. A retry with the same lease key, amount, and ttlMs returns the same lease. A budget past its closesAt returns 409.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(leaseBudgetInputSchema, "The lease request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(leaseBudgetResponseSchema, "The lease"),
        ...openApiBudgetErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: false },
      sdk: { path: ["budgets", "lease"] },
    }
  )
)

export const registerLeaseBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, ...request } = c.req.valid("json")
    const { type: _, ...leased } = await runBudgetVerb(c, key, { type: "lease", ...request })
    return c.json(toWire(leased), HttpStatusCodes.OK)
  })
