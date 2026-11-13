import { createRoute } from "@hono/zod-openapi"
import {
  sealPayerStatements,
  sealPayerStatementsInputSchema,
  sealPayerStatementsOutputSchema,
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
      path: "/v1/internal/payer-budgets/seal",
      operationId: "budgets.internalSealPayerStatements",
      summary: "seal a payer budget's statements for invoicing",
      description:
        "Seals the statements of one statement key in the budget at unprice:customer:<customerId> that ended by `at`, closes the key's prepaid wallet funding, and answers the sealed statements with the usage the budget priced at ingestion, plus the period ids of the key still open. Called by billing before it invoices the statement key.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(sealPayerStatementsInputSchema, "The statement key to seal"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(sealPayerStatementsOutputSchema, "The sealed statements"),
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

export const registerSealPayerStatementsInternalV1 = (app: App) =>
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
    const result = await sealPayerStatements(deps, input)
    if (result.err) throw toUnpriceApiError(result.err)
    return c.json(result.val, HttpStatusCodes.OK)
  })
