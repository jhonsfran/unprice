import { createRoute } from "@hono/zod-openapi"
import { FetchError } from "@unprice/error"
import { UnPriceCustomerError } from "@unprice/services/customers"
import { StripePaymentProvider } from "@unprice/services/payment-provider"
import { processWebhookEvent } from "@unprice/services/use-cases"
import { z } from "zod"
import { UnpriceApiError, openApiErrorResponses, toUnpriceApiError } from "~/errors"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["paymentProviderCallbacks"]

const webhookResponseSchema = z.object({
  received: z.literal(true),
  webhookEventId: z.string().optional(),
  providerEventId: z.string(),
  status: z.enum(["processed", "duplicate", "ignored"]),
  outcome: z.enum([
    "payment_succeeded",
    "payment_failed",
    "payment_reversed",
    "payment_dispute_reversed",
    "wallet_topup_settled",
    "provider_signup_completed",
    "ignored",
  ]),
  invoiceId: z.string().optional(),
  subscriptionId: z.string().optional(),
  topupId: z.string().optional(),
})

const STRIPE_CONNECT_WEBHOOK_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.funds_reinstated",
  "charge.dispute.funds_withdrawn",
  "charge.refunded",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
])

function isStripeConnectLifecycleEvent(eventType: string): boolean {
  return (
    eventType.startsWith("account.") ||
    eventType.startsWith("capability.") ||
    eventType.startsWith("person.")
  )
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    result[name.toLowerCase()] = value
  }
  return result
}

function getStripeConnectAccountId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("account" in payload)) {
    return null
  }

  const account = (payload as { account?: unknown }).account
  return typeof account === "string" ? account : null
}

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/payment-provider-callbacks/stripe-connect/webhook",
      operationId: "paymentProviderCallbacks.stripeConnectWebhook",
      hide: true,
      summary: "Stripe Connect webhook",
      description:
        "Stripe Connect platform webhook endpoint. Verifies the platform Connect signature, maps the connected account to a project, and processes the provider event idempotently.",
      method: "post",
      tags,
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
    },
    {
      audience: "callback",
      category: "configuration",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)

export const registerProviderStripeConnectWebhookV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const rawBody = await c.req.raw.text()

    if (!rawBody) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "Webhook body is required",
      })
    }

    if (!c.env.STRIPE_API_KEY || !c.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe Connect webhook is not configured",
      })
    }

    const headers = collectHeaders(c.req.raw.headers)
    const platformProvider = new StripePaymentProvider({
      token: c.env.STRIPE_API_KEY,
      webhookSecret: c.env.STRIPE_CONNECT_WEBHOOK_SECRET,
      logger: c.get("logger"),
    })

    const verified = await platformProvider.verifyWebhook({
      rawBody,
      headers,
    })

    if (verified.err) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: verified.err.message,
      })
    }

    const processableEvent = STRIPE_CONNECT_WEBHOOK_EVENT_TYPES.has(verified.val.eventType)
    const lifecycleEvent = isStripeConnectLifecycleEvent(verified.val.eventType)

    if (!processableEvent && !lifecycleEvent) {
      c.get("logger").debug("Stripe Connect webhook ignored: unsupported event type", {
        providerEventId: verified.val.eventId,
        providerEventType: verified.val.eventType,
      })

      return c.json(
        {
          received: true as const,
          providerEventId: verified.val.eventId,
          status: "ignored" as const,
          outcome: "ignored" as const,
        },
        HttpStatusCodes.OK
      )
    }

    const externalAccountId = getStripeConnectAccountId(verified.val.payload)

    if (!externalAccountId) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "Stripe Connect event account is required",
      })
    }

    const config = await c.get("db").query.paymentProviderConfig.findFirst({
      where: (table, ops) =>
        ops.and(
          ops.eq(table.paymentProvider, "stripe"),
          ops.eq(table.connectionType, "managed_connection"),
          ops.eq(table.externalAccountId, externalAccountId)
        ),
    })

    if (!config) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "Unknown Stripe connected account",
      })
    }

    if (lifecycleEvent) {
      c.get("logger").debug("Stripe Connect lifecycle webhook accepted", {
        providerEventId: verified.val.eventId,
        providerEventType: verified.val.eventType,
        externalAccountId,
        projectId: config.projectId,
      })

      return c.json(
        {
          received: true as const,
          providerEventId: verified.val.eventId,
          status: "ignored" as const,
          outcome: "ignored" as const,
        },
        HttpStatusCodes.OK
      )
    }

    const { billing, customer, subscription, wallet } = c.get("services")

    const { err, val } = await processWebhookEvent(
      {
        services: {
          billing,
          customers: customer,
          subscriptions: subscription,
          wallet,
        },
        db: c.get("db"),
        logger: c.get("logger"),
        analytics: c.get("analytics"),
        waitUntil: c.get("waitUntil"),
      },
      {
        projectId: config.projectId,
        provider: "stripe",
        rawBody,
        headers,
        verifiedWebhook: verified.val,
        includeInactiveProvider: true,
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
