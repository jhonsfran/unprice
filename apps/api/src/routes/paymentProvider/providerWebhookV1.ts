import { env } from "cloudflare:workers"
import { createRoute } from "@hono/zod-openapi"
import { paymentProviderSchema } from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import { UnPriceCustomerError } from "@unprice/services/customers"
import { processWebhookEvent } from "@unprice/services/use-cases"
import { z } from "zod"
import { UnpriceApiError, openApiErrorResponses, toUnpriceApiError } from "~/errors"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["paymentProvider"]

const webhookResponseSchema = z.object({
  received: z.literal(true),
  webhookEventId: z.string(),
  providerEventId: z.string(),
  status: z.enum(["processed", "duplicate"]),
  outcome: z.enum([
    "payment_succeeded",
    "payment_failed",
    "payment_reversed",
    "payment_dispute_reversed",
    "ignored",
  ]),
  invoiceId: z.string().optional(),
  subscriptionId: z.string().optional(),
})

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    result[name.toLowerCase()] = value
  }
  return result
}

export const route = createRoute({
  path: "/v1/paymentProvider/{provider}/webhook/{projectId}",
  hide: env.NODE_ENV === "production",
  summary: "provider webhook",
  description:
    "Generic provider webhook endpoint. Verifies signature, normalizes provider payload, and processes settlement side effects idempotently.",
  method: "post",
  tags,
  request: {
    params: z.object({
      provider: paymentProviderSchema,
      projectId: z.string().openapi({
        description: "The project id that owns the payment provider configuration",
        example: "proj_123",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: webhookResponseSchema,
        },
      },
      description: "Webhook accepted and processed idempotently",
    },
    ...openApiErrorResponses,
  },
})

export const registerProviderWebhookV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { provider, projectId } = c.req.valid("param")
    const { customer, subscription, ledger } = c.get("services")
    const rawBody = await c.req.raw.text()

    if (!rawBody) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "Webhook body is required",
      })
    }

    const { err, val } = await processWebhookEvent(
      {
        services: {
          customers: customer,
          subscriptions: subscription,
          ledger,
        },
        db: c.get("db"),
        logger: c.get("logger"),
      },
      {
        projectId,
        provider,
        rawBody,
        headers: collectHeaders(c.req.raw.headers),
      }
    )

    if (err) {
      if (err instanceof UnPriceCustomerError && err.code === "PAYMENT_PROVIDER_ERROR") {
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: err.message,
        })
      }

      if (err instanceof FetchError) {
        throw new UnpriceApiError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message,
        })
      }

      throw toUnpriceApiError(err)
    }

    return c.json(
      {
        received: true as const,
        ...val,
      },
      HttpStatusCodes.OK
    )
  })
