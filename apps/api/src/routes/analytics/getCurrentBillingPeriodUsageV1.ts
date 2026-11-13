import { createRoute } from "@hono/zod-openapi"
import { parseAmount, spendingOf } from "@unprice/money"
import {
  type GetCurrentBillingPeriodUsageOutput,
  getCurrentBillingPeriodUsage,
} from "@unprice/services/use-cases"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import {
  keyAuth,
  resolveCustomerIdForApiKeyOrThrow,
  validateIsAllowedToAccessProject,
} from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { requestBudgetCommandDeps } from "~/ingestion/budget/deps"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetApiError } from "../budgets/budget-verb"

const tags = ["analytics"]

const billingPeriodUsageSchema = z.object({
  billing_period_id: z.string(),
  cycle_start_at: z.number().int(),
  cycle_end_at: z.number().int(),
  usage: z.array(
    z.object({
      feature_slug: z.string(),
      usage: z.number(),
      spending: z.object({
        amount: z.string(),
        currency: z.string().length(3),
        display_amount: z.string(),
      }),
    })
  ),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/analytics/usage/current-billing-period",
      operationId: "analytics.usage.currentBillingPeriod",
      summary: "get current billing-period usage",
      description:
        "Get metered usage and priced deltas for the customer's active subscription billing period. This reports billing data; use access.check for real-time quota enforcement.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            customer_id: z.string().optional().openapi({
              description: "The customer ID. Optional when the API key is bound to a customer.",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            }),
            project_id: z.string().optional().openapi({
              description: "The project ID. Only main-project keys can select another project.",
              example: "project_1H7KQFLr7RepUyQBKdnvY",
            }),
          }),
          "Current billing-period usage request"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          z.object({ billing_periods: z.array(billingPeriodUsageSchema) }),
          "Current billing-period usage"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "analytics",
      docs: { expose: true },
      sdk: { path: ["analytics", "usage", "currentBillingPeriod"] },
    }
  )
)

export type GetCurrentBillingPeriodUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetCurrentBillingPeriodUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

function formatUsage(
  row: GetCurrentBillingPeriodUsageOutput["billingPeriods"][number]["usage"][number]
) {
  const parsed = parseAmount(row.amount)
  if (!parsed.ok) throw new Error(`invalid budget amount: ${row.amount}`)
  const spending = spendingOf(parsed.amount, row.unit)
  return {
    feature_slug: row.featureSlug,
    usage: row.usage,
    spending: {
      amount: spending.amount,
      currency: spending.currency,
      display_amount: spending.displayAmount,
    },
  }
}

export const registerGetCurrentBillingPeriodUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customer_id: inputCustomerId, project_id: inputProjectId } = c.req.valid("json")
    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: inputCustomerId,
      defaultCustomerId: key.defaultCustomerId,
    })
    const projectId = validateIsAllowedToAccessProject({
      key,
      requestedProjectId: inputProjectId ?? key.projectId,
    })
    const now = c.get("requestStartedAt")

    startTime(c, "getCurrentBillingPeriodUsage")

    // Live from the payer budget (ADR-0008 D7): its open statements, priced at ingestion.
    const result = await getCurrentBillingPeriodUsage(
      { budgets: requestBudgetCommandDeps(c).budgets, now: () => now },
      { projectId, customerId }
    )

    endTime(c, "getCurrentBillingPeriodUsage")

    if (result.err) {
      throw budgetApiError(c, result.err)
    }

    const billing_periods = result.val.billingPeriods.map((period) => ({
      billing_period_id: period.id,
      cycle_start_at: period.cycleStartAt,
      cycle_end_at: period.cycleEndAt,
      usage: period.usage.map(formatUsage),
    }))

    return c.json({ billing_periods }, HttpStatusCodes.OK)
  })
