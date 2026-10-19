import { createRoute } from "@hono/zod-openapi"
import { reportBudgetInputSchema, reportBudgetResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { extensionToWire, runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/report",
      operationId: "budgets.report",
      summary: "report a lease's usage, and extend or close it",
      description:
        "Report the cumulative usage spent from a lease. A report that is not final may ask for more capacity: what fits is granted, and a short extension is part of the answer, never an error, so the usage always counts. Reports renew the lease once less than half its ttlMs remains. A final report closes the lease and returns the unused grant. Reports are numbered from 1; resending the last one replays its answer, and any other number returns 409. After expiresAt only a final report is accepted.",
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(reportBudgetInputSchema, "The report"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(reportBudgetResponseSchema, "The lease after the report"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: false },
      sdk: { path: ["budgets", "report"] },
    }
  )
)

export const registerReportBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, leaseKey, seq, ...request } = c.req.valid("json")
    const {
      type: _,
      extension,
      ...reported
    } = await runBudgetVerb(c, key, {
      type: "report",
      leaseKey,
      seq,
      request,
    })
    return c.json(
      { ...toWire(reported), extension: extensionToWire(extension, reported.balance) },
      HttpStatusCodes.OK
    )
  })
