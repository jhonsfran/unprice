import { createRoute } from "@hono/zod-openapi"
import {
  completeInvoicedPayerStatements,
  completePayerStatementsInputSchema,
  completePayerStatementsOutputSchema,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { requestBudgetCommandDeps } from "~/ingestion/budget/deps"
import { payerBudgetSyncDeps } from "~/ingestion/budget/payer-budget-sync"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/payer-budgets/complete",
      operationId: "budgets.internalCompletePayerStatements",
      summary: "complete a payer budget's invoiced statements",
      description:
        "Completes every sealed statement of the budget at unprice:customer:<customerId> whose billing period is invoiced or voided. Called by billing after an invoice commits; idempotent.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(
          completePayerStatementsInputSchema,
          "The customer whose statements to complete"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          completePayerStatementsOutputSchema,
          "The completed statements"
        ),
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

export const registerCompletePayerStatementsInternalV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // `internalKeyAuth` admits only main and internal keys, so the project comes from the body.
    const input = c.req.valid("json")
    const deps = payerBudgetSyncDeps({
      budgets: requestBudgetCommandDeps(c).budgets,
      env: c.env,
      db: c.get("db"),
      services: c.get("services"),
      logger: c.get("logger"),
      waitUntil: c.get("waitUntil"),
    })
    const result = await completeInvoicedPayerStatements(deps, input)
    if (result.err) throw toUnpriceApiError(result.err)
    return c.json(result.val, HttpStatusCodes.OK)
  })
