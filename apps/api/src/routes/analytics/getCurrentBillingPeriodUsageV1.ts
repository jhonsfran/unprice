import { createRoute } from "@hono/zod-openapi"
import type { Currency } from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import {
  BillingPeriodUsageCoverageError,
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
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { serializeError } from "~/errors/log"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

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

function trimInsignificantZeros(amount: string): string {
  if (!amount.includes(".")) return amount
  return amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
}

function formatUsage(
  row: GetCurrentBillingPeriodUsageOutput["billingPeriods"][number]["usage"][number]
) {
  const currency = row.currency as Currency
  const amount = trimInsignificantZeros(toDecimal(fromLedgerMinor(row.amount, currency)))

  return {
    feature_slug: row.featureSlug,
    usage: row.usage,
    spending: {
      amount,
      currency,
      display_amount: formatMoney(amount, currency),
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
    const db = c.get("db")
    const analytics = c.get("analytics")
    const logger = c.get("logger")

    startTime(c, "getCurrentBillingPeriodUsage")

    const result = await getCurrentBillingPeriodUsage(
      {
        analytics,
        db,
        now: () => now,
      },
      {
        projectId,
        customerId,
      }
    )

    if (result.err instanceof BillingPeriodUsageCoverageError) {
      const serializedError = serializeError(result.err)
      logger.warn("current billing-period usage is incomplete before attribution migration", {
        error: serializedError,
        error_message: serializedError.message,
        pipe: "v1_get_billing_period_usage_coverage",
        project_id: projectId,
        customer_id: customerId,
        request_id: c.get("requestId"),
      })
      throw new UnpriceApiError({
        code: "PRECONDITION_FAILED",
        message: result.err.message,
      })
    }

    if (result.err) {
      const serializedError = serializeError(result.err)
      logger.error("current billing-period usage tinybird query failed", {
        error: serializedError,
        error_message: serializedError.message,
        pipe: "v1_get_billing_period_usage",
        project_id: projectId,
        customer_id: customerId,
        request_id: c.get("requestId"),
      })
      throw toUnpriceApiError(result.err)
    }

    const billing_periods = result.val.billingPeriods.map((period) => ({
      billing_period_id: period.id,
      cycle_start_at: period.cycleStartAt,
      cycle_end_at: period.cycleEndAt,
      usage: period.usage.map(formatUsage),
    }))

    endTime(c, "getCurrentBillingPeriodUsage")
    return c.json({ billing_periods }, HttpStatusCodes.OK)
  })
