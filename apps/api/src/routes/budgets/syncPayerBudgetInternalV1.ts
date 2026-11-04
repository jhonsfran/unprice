import { createRoute } from "@hono/zod-openapi"
import {
  rateCardSource,
  syncPayerBudget,
  syncPayerBudgetInputSchema,
  syncPayerBudgetOutputSchema,
  walletFunding,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/payer-budgets/sync",
      operationId: "budgets.internalSyncPayer",
      summary: "compile a customer's subscription into its payer budget",
      description:
        "Compiles the customer's subscription phases, items, grants, and rate card into the budget at unprice:customer:<customerId>, upserts it with its pricing, and registers its billing periods as statements. Called by billing after a subscription is created, changed, canceled, or renewed, and after billing periods are generated. A pricing change refused while holds are open is retried for up to retryForMs.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(syncPayerBudgetInputSchema, "The customer to sync"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(syncPayerBudgetOutputSchema, "The synced budget"),
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

export const registerSyncPayerBudgetInternalV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // `internalKeyAuth` admits only main and internal keys, so the project comes from the body.
    const input = c.req.valid("json")
    const { budgetCatalog, rateCards, wallet } = c.get("services")
    const result = await syncPayerBudget(
      {
        db: c.get("db"),
        // Straight to the budget: `runBudgetVerb` refuses to define an `unprice:` key.
        budgets: new CloudflareBudgetClient(c.env),
        cards: rateCardSource(rateCards),
        wallet: walletFunding(wallet),
        services: { budgetCatalog, rateCards },
        logger: c.get("logger"),
        waitUntil: c.get("waitUntil"),
      },
      input
    )
    if (result.err) throw toUnpriceApiError(result.err)
    return c.json(result.val, HttpStatusCodes.OK)
  })
