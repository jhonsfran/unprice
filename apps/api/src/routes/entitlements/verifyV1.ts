import { createRoute } from "@hono/zod-openapi"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import {
  PAYER_ACCESS_DENIALS,
  checkPayerAccess,
  checkPayerAccessOutputSchema,
  payerQuotaWindowSchema,
} from "@unprice/services/use-cases"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareBudgetClient } from "~/ingestion/budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetApiError } from "../budgets/budget-verb"

const tags = ["access"]

const accessCheckResponseSchema = checkPayerAccessOutputSchema.extend({
  featureSlug: z.string().openapi({ description: "The feature slug that was checked" }),
  allowed: z.boolean().openapi({
    description: "Whether the customer may use the feature now",
    example: true,
  }),
  rejectionReason: z.enum(PAYER_ACCESS_DENIALS).optional().openapi({
    description:
      "Why the feature is not usable: NO_ENTITLEMENT (the customer's plan has no such feature, or its subscription budget does not exist yet), LIMIT_EXCEEDED (a hard limit has no room), or BUDGET_CLOSED (the subscription ended). Omitted when allowed is true.",
    example: "LIMIT_EXCEEDED",
  }),
  metered: z.boolean().openapi({
    description:
      "True when the customer's subscription budget meters the feature: usage and limit are live",
  }),
  usage: z.number().optional().openapi({
    description:
      "Quantity used in the limit's current window. Present for a limited metered feature.",
    example: 42,
  }),
  limit: z.number().nullable().openapi({
    description:
      "The feature's quantity limit, or the subscribed quantity of a seat or package feature; null when unlimited",
    example: 100,
  }),
  quotaWindow: payerQuotaWindowSchema.nullable().openapi({
    description:
      "The window the limit counts in: periodKey is the limit id, endAt (exclusive) is when it resets, null for a limit that never resets",
  }),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/access/check",
      operationId: "access.check",
      summary: "check whether a customer may use a feature",
      description:
        "Answer whether a feature is usable for a customer now. A metered feature answers from the customer's subscription budget with its live usage and limit; a flat, seat, or package feature answers from the customer's plan.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            customerId: z.string().openapi({
              description: "The unprice customer ID",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            }),
            featureSlug: z.string().openapi({
              description: "The feature slug",
              example: "tokens",
            }),
          }),
          "Body of the request"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(accessCheckResponseSchema, "The feature's access now"),
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
        path: ["access", "check"],
      },
    }
  )
)

export type VerifyRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type VerifyResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerVerifyV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId: inputCustomerId, featureSlug } = c.req.valid("json")
    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: inputCustomerId,
      defaultCustomerId: key.defaultCustomerId,
    })
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    startTime(c, "verify")
    const result = await checkPayerAccess(
      {
        budgets: new CloudflareBudgetClient(c.env),
        entitlements: c.get("services").entitlement,
      },
      { projectId, customerId, featureSlug, now: c.get("requestStartedAt") }
    )
    endTime(c, "verify")

    if (result.err) {
      throw result.err instanceof UnPriceBudgetError
        ? budgetApiError(c, result.err)
        : toUnpriceApiError(result.err)
    }
    return c.json(result.val, HttpStatusCodes.OK)
  })
