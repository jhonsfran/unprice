import { createRoute } from "@hono/zod-openapi"
import {
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_DEDUPE_MS,
  describeDuration,
  recordBudgetInputSchema,
  recordBudgetResponseSchema,
} from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/record",
      operationId: "budgets.record",
      summary: "record usage that already happened",
      description: `Consume an amount for work that already ran. It always counts, even past a hard limit, because the work cannot be undone: \`crossed\` names any limit it passed, and hard limits then deny authorize and charge. Usage must have occurred within the last ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} (409 beyond it). For ${describeDuration(RECORD_DEDUPE_MS)}, a retry with the same idempotency key and amount replays instead of counting twice, and the same key with another amount returns 409.`,
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
    const { type: _, ...recorded } = await runBudgetVerb(c, key, { type: "record", ...request })
    return c.json(toWire(recorded), HttpStatusCodes.OK)
  })
