import { createRoute } from "@hono/zod-openapi"
import { consumeUsageInputSchema, consumeUsageResponseSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiBudgetErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import { bouncer } from "~/util/bouncer"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { budgetApiError, setBudgetRemaining } from "../budgets/budget-verb"
import { consumedToWire } from "../budgets/wire"
import { meterPayerUsageReported, usageBodyLimit } from "./payer-usage"

export const USAGE_CONSUME_PATH = "/v1/usage/consume"
const USAGE_CONSUME_MAX_BODY_BYTES = 16 * 1024

export const route = createRoute(
  defineEndpointContract(
    {
      path: USAGE_CONSUME_PATH,
      operationId: "usage.consume",
      summary: "consume usage if it fits",
      description:
        "Price one usage event in the customer's subscription budget and count it only if it fits every hard limit, before the work runs. A denial returns 402 with the limit that blocked it, or without details when a prepaid wallet cannot fund it. An event no rate matches returns 400 (NOT_PRICED), as does an event no metered feature takes (UNKNOWN_EVENT). A retry with the same idempotency key replays the first answer.",
      method: "post",
      tags: ["usage"],
      request: {
        body: jsonContentRequired(consumeUsageInputSchema, "The usage event"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(consumeUsageResponseSchema, "The consumed usage"),
        ...openApiBudgetErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["usage", "consume"] },
    }
  )
)

export const registerConsumeUsageV1 = (app: App) => {
  app.use(USAGE_CONSUME_PATH, usageBodyLimit(USAGE_CONSUME_MAX_BODY_BYTES))

  return app.openapi(route, async (c) => {
    const event = c.req.valid("json")
    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: event.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)
    await bouncer(c, customerId, projectId)

    const [consumed] = await meterPayerUsageReported(c, {
      verb: "charge",
      events: [{ ...event, customerId, projectId }],
      receivedAt: c.get("requestStartedAt"),
    })

    if (!consumed) throw new Error("usage consume answered no result")
    // The budget was never reached: answer the transport failure as an internal error.
    if ("unavailable" in consumed) throw toUnpriceApiError(consumed.unavailable)
    if (consumed.result.err) throw budgetApiError(c, consumed.result.err)
    const { type: _, created: __, ...charged } = consumed.result.val
    setBudgetRemaining(c, charged)
    return c.json(
      { allowed: true as const, customerId, ...consumedToWire(charged) },
      HttpStatusCodes.OK
    )
  })
}
