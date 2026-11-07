import { createRoute } from "@hono/zod-openapi"
import { inspectBudgetRequestSchema, inspectBudgetResponseSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import {
  admissionToWire,
  amountToWire,
  budgetToWire,
  inspectBudget,
  operationToWire,
  periodToWire,
  reservationToWire,
} from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/budgets/inspect",
      operationId: "budgets.internalInspect",
      summary: "inspect a budget for the dashboard",
      description:
        "The budget's snapshot and history, the open reservations that expire next, the rows closed in the last hour, and optionally one row found by id or key and an amount probed against the authorize rule. Called by the dashboard with a main-project key, for any project.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(inspectBudgetRequestSchema, "The budget and what to inspect"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(inspectBudgetResponseSchema, "The inspection"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: { expose: false },
      sdk: false,
    }
  )
)

export const registerInspectBudgetInternalV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // `internalKeyAuth` admits only main and internal keys, so the project comes from the body.
    const { projectId, key, ...query } = c.req.valid("json")
    const { budget, history, expiringNext, listed, closedRecently, found, probe } =
      await inspectBudget(c, { projectId, key }, query)
    return c.json(
      {
        budget: budgetToWire(budget),
        history: history.map(periodToWire),
        expiringNext: { ...expiringNext, rows: expiringNext.rows.map(reservationToWire) },
        listed: amountToWire(listed),
        closedRecently: closedRecently.map(operationToWire),
        ...(found !== undefined && { found: found && operationToWire(found) }),
        ...(probe && {
          probe: {
            amount: formatAmount(probe.amount),
            rejection: probe.rejection && admissionToWire(probe.rejection),
          },
        }),
      },
      HttpStatusCodes.OK
    )
  })
