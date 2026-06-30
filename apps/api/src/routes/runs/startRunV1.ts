import { createRoute } from "@hono/zod-openapi"
import { runSummarySchema, startRunInputSchema } from "@unprice/db/validators"
import { fromLedgerMinor, toCurrencyMinor } from "@unprice/money"
import { RunUseCaseError, startRunForCustomerSubscription } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, resolveCustomerIdForApiKey } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["runs"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/runs/start",
      operationId: "runs.start",
      summary: "start a budgeted run",
      description:
        "Start a new budgeted run with a budget reservation against a customer. " +
        "The currency is inherited from the customer's active subscription plan. " +
        "budgetAmount is in currency minor units (e.g. 500 = $5.00 USD).",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(startRunInputSchema, "The run configuration"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(runSummarySchema, "The budget run summary"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["runs", "start"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    }
  )
)

export const registerStartRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const key = await keyAuth(c)

    const customer = resolveCustomerIdForApiKey({
      explicitCustomerId: body.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    if (!customer.success) {
      throw new UnpriceApiError({
        code: customer.code === "customer_forbidden" ? "FORBIDDEN" : "BAD_REQUEST",
        message: customer.message,
      })
    }

    const { customer: customerService, subscription: subscriptionService } = c.get("services")
    const logger = c.get("logger")
    const { budgetRuns } = c.get("services")
    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await startRunForCustomerSubscription(
      {
        services: {
          budgetRuns,
          customer: customerService,
          subscription: subscriptionService,
        },
        runBudget,
        logger,
      },
      {
        projectId: key.projectId,
        customerId: customer.customerId,
        budgetAmountCurrencyMinor: body.budgetAmount,
        idempotencyKey: body.idempotencyKey,
        workloadType: body.workloadType,
        workloadId: body.workloadId,
        traceId: body.traceId,
        parentRunId: body.parentRunId,
        metadata: body.metadata,
        expiresAt: body.expiresAt,
      }
    )

    if (result.err) {
      if (result.err instanceof RunUseCaseError && result.err.message === "SUBSCRIPTION_REQUIRED") {
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message:
            "Customer has no active subscription. A subscription with an active plan is required to start a budgeted run.",
        })
      }

      if (result.err instanceof RunUseCaseError && result.err.message === "WALLET_EMPTY") {
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message:
            "Insufficient wallet balance to reserve budget. Top up the customer wallet or reduce the budget amount.",
        })
      }

      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    // Convert response amounts from ledger scale back to currency minor units
    const { currency } = result.val
    return c.json(
      {
        ...result.val,
        budgetAmount: toCurrencyMinor(fromLedgerMinor(result.val.budgetAmount, currency)),
        consumedAmount: toCurrencyMinor(fromLedgerMinor(result.val.consumedAmount, currency)),
        remainingAmount: toCurrencyMinor(fromLedgerMinor(result.val.remainingAmount, currency)),
      },
      HttpStatusCodes.OK
    )
  })
