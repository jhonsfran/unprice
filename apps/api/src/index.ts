import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, getAllowedCorsOrigin } from "@unprice/config"
import { log } from "evlog"
import { partyserverMiddleware } from "hono-party"
import { cors } from "hono/cors"
import { type Env, createRuntimeEnv } from "~/env"
import { newApp } from "~/hono/app"
import { init } from "~/middleware/init"

import serveEmojiFavicon from "stoker/middlewares/serve-emoji-favicon"

export { DurableObjectProject } from "~/project/do"
export { EntitlementWindowDO } from "~/ingestion/entitlements/EntitlementWindowDO"
export { RunBudgetDO } from "~/ingestion/run-budget/RunBudgetDO"

import { registerUpdateACLV1 } from "./routes/access/updateACLV1"
import { registerExplainChargeV1 } from "./routes/analytics/explainChargeV1"
import { registerGetIngestionStatusV1 } from "./routes/analytics/getIngestionStatusV1"
import { registerGetAnalyticsUsageV1 } from "./routes/analytics/getUsageV1"
import { registerFlushReservationsForInvoicingV1 } from "./routes/billing/flushReservationsForInvoicingV1"
import { registerSignUpV1 } from "./routes/customers/signUpV1"
import { registerGetEntitlementWindowStatusV1 } from "./routes/entitlements/getEntitlementWindowStatusV1"
import { registerGetEntitlementsV1 } from "./routes/entitlements/getEntitlementsV1"
import { registerVerifyV1 } from "./routes/entitlements/verifyV1"
import { registerIngestEventsSyncV1 } from "./routes/events/ingestEventsSyncV1"
import { registerIngestEventsV1 } from "./routes/events/ingestEventsV1"
import { registerReplayIngestionEventsV1 } from "./routes/events/replayIngestionEventsV1"
import { registerGetFeaturesV1 } from "./routes/features/getFeaturesV1"
import { registerCreatePaymentMethodV1 } from "./routes/payments/methods/createPaymentMethodV1"
import { registerListPaymentMethodsV1 } from "./routes/payments/methods/listPaymentMethodsV1"
import { registerProviderSetupV1 } from "./routes/payments/providers/providerSetupV1"
import { registerProviderSignUpV1 } from "./routes/payments/providers/providerSignUpV1"
import { registerProviderStripeConnectWebhookV1 } from "./routes/payments/providers/providerStripeConnectWebhookV1"
import { registerProviderWebhookV1 } from "./routes/payments/providers/providerWebhookV1"
import { registerGetPlanVersionV1 } from "./routes/plans/getPlanVersionV1"
import { registerListPlanVersionsV1 } from "./routes/plans/listPlanVersionsV1"
import { registerApplyRunSyncEventV1 } from "./routes/runs/applyRunSyncEventV1"
import { registerEndRunV1 } from "./routes/runs/endRunV1"
import { registerGetRunV1 } from "./routes/runs/getRunV1"
import { registerStartRunV1 } from "./routes/runs/startRunV1"
import { registerGetSubscriptionV1 } from "./routes/subscriptions/getSubscriptionV1"

import { env } from "cloudflare:workers"
import type { IngestionQueueMessage, IngestionReportingEnvelope } from "@unprice/services/ingestion"
import { timing } from "hono/timing"
import { verifyRealtimeTicket } from "~/auth/ticket"
import { serializeError } from "~/errors/log"
import { dispatchIngestionQueueBatch } from "~/ingestion/queue-routing"
import {
  consumeIngestionReportingDlqBatch,
  consumeIngestionReportingQueueBatch,
} from "~/ingestion/reporting/consumer"
import { consumeIngestionBatch, consumeIngestionDlqBatch } from "~/ingestion/service"
import { internalKeyAuth } from "~/middleware/internal-key"
import { knownRoute } from "~/middleware/known-route"
import { obs } from "~/middleware/obs"
import { apiDrain, apiEvlog } from "~/observability"
import { registerGetInvoiceV1 } from "./routes/invoices/getInvoiceV1"
import { registerGetWalletV1 } from "./routes/wallet/getWalletV1"

const app = newApp()

app.use(timing())
app.use(
  "*",
  knownRoute(() => app.routes)
)
app.use(serveEmojiFavicon("◎"))
app.use(
  "*",
  cors({
    allowHeaders: [...CORS_ALLOW_HEADERS],
    allowMethods: [...CORS_ALLOW_METHODS],
    origin: (origin) => getAllowedCorsOrigin(origin) ?? undefined,
  })
)
app.use("*", apiEvlog)
app.use("*", init())
app.use("*", obs())

const resolvePartyAndRoomFromPath = (pathname: string) => {
  const pathParts = pathname.split("/").filter((part) => part.length > 0)
  const broadcastIndex = pathParts.indexOf("broadcast")
  if (broadcastIndex < 0) {
    return {
      party: null,
      room: null,
    }
  }

  const party = pathParts[broadcastIndex + 1] ?? null
  const encodedRoom = pathParts.slice(broadcastIndex + 2).join("/")

  return {
    party,
    room: encodedRoom ? decodeURIComponent(encodedRoom) : null,
  }
}

// Handle websocket connections for Durable Objects
app.use(
  "/broadcast/**",
  partyserverMiddleware({
    onError: (error) => log.error({ message: "Partyserver websocket error", error }),
    options: {
      prefix: "broadcast",
      onBeforeConnect: async (req) => {
        const url = new URL(req.url)
        const { room } = resolvePartyAndRoomFromPath(url.pathname)

        const ticket = url.searchParams.get("ticket")

        if (!ticket) {
          return new Response("Unauthorized", { status: 401 })
        }

        try {
          const runtimeEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)
          const payload = await verifyRealtimeTicket({
            token: ticket,
            secret: runtimeEnv.REALTIME_TICKET_SECRET,
          })

          if (!payload.customerId.startsWith("cus_")) {
            return new Response("Unauthorized", { status: 401 })
          }

          if (!room) {
            return new Response("Forbidden", { status: 403 })
          }

          const roomParts = room.split(":")
          if (roomParts.length < 3) {
            return new Response("Forbidden", { status: 403 })
          }

          const roomProjectId = roomParts[roomParts.length - 2]
          const roomCustomerId = roomParts[roomParts.length - 1]

          if (payload.projectId !== roomProjectId || payload.customerId !== roomCustomerId) {
            return new Response("Forbidden", { status: 403 })
          }
        } catch (error) {
          if (error instanceof Error && error.message === "Ticket expired") {
            return new Response("Ticket expired", { status: 401 })
          }
          return new Response("Unauthorized", { status: 401 })
        }

        return
      },
    },
  })
)

// Internal routes require an internal or main project key
app.use("/v1/internal/*", internalKeyAuth())

// Access routes
registerUpdateACLV1(app)

// Run routes
registerStartRunV1(app)
registerApplyRunSyncEventV1(app)
registerEndRunV1(app)
registerGetRunV1(app)

// Billing routes
registerFlushReservationsForInvoicingV1(app)

// Customer routes
registerSignUpV1(app)

// Entitlement routes
registerGetEntitlementsV1(app)
registerVerifyV1(app)

// Event routes
registerIngestEventsV1(app)
registerIngestEventsSyncV1(app)
registerReplayIngestionEventsV1(app)
registerGetEntitlementWindowStatusV1(app)

// Feature routes
registerGetFeaturesV1(app)

// Invoice routes
registerGetInvoiceV1(app)

// Payment routes
registerListPaymentMethodsV1(app)
registerCreatePaymentMethodV1(app)
registerProviderSignUpV1(app)
registerProviderSetupV1(app)
registerProviderWebhookV1(app)
registerProviderStripeConnectWebhookV1(app)

// Plans routes
registerGetPlanVersionV1(app)
registerListPlanVersionsV1(app)

// Subscription routes
registerGetSubscriptionV1(app)

// Usage routes
registerExplainChargeV1(app)
registerGetIngestionStatusV1(app)
registerGetAnalyticsUsageV1(app)

// Wallet routes
registerGetWalletV1(app)

// Export handler
const handler = {
  fetch: (req: Request, env: Env, executionCtx: ExecutionContext) => {
    try {
      const parsedEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)

      return app.fetch(req, parsedEnv, executionCtx)
    } catch (error) {
      const serializedError = serializeError(error)

      log.error({
        code: "BAD_ENVIRONMENT",
        message: "Invalid API environment",
        error: serializedError,
        error_message: serializedError.message,
      })
      if (apiDrain) {
        executionCtx.waitUntil(apiDrain.flush())
      }

      return Response.json(
        {
          code: "BAD_ENVIRONMENT",
          message: "Some environment variables are missing or are invalid",
          errors: serializedError.message,
        },
        { status: 500 }
      )
    }
  },
  queue: async (
    batch: MessageBatch<IngestionQueueMessage | IngestionReportingEnvelope>,
    env: Env,
    executionCtx: ExecutionContext
  ) => {
    try {
      const parsedEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)
      await dispatchIngestionQueueBatch(batch, {
        consumers: {
          raw: (queueBatch) =>
            consumeIngestionBatch(queueBatch, parsedEnv, executionCtx, apiDrain ?? undefined),
          raw_dlq: (queueBatch) =>
            consumeIngestionDlqBatch(queueBatch, parsedEnv, executionCtx, apiDrain ?? undefined),
          reporting: (queueBatch) =>
            consumeIngestionReportingQueueBatch(
              queueBatch,
              parsedEnv,
              executionCtx,
              apiDrain ?? undefined
            ),
          reporting_dlq: (queueBatch) =>
            consumeIngestionReportingDlqBatch(
              queueBatch,
              parsedEnv,
              executionCtx,
              apiDrain ?? undefined
            ),
        },
        onUnknownQueue: ({ queue }) => {
          log.error({
            code: "UNKNOWN_INGESTION_QUEUE",
            message: "retrying messages from unknown ingestion queue",
            queue,
          })
        },
      })
    } catch (error) {
      const serializedError = serializeError(error)

      log.error({
        code: "BAD_ENVIRONMENT",
        message: "Invalid API queue environment",
        error: serializedError,
        error_message: serializedError.message,
      })
      if (apiDrain) {
        executionCtx.waitUntil(apiDrain.flush())
      }

      throw error
    }
  },
} satisfies ExportedHandler<Env, IngestionQueueMessage | IngestionReportingEnvelope>

export default handler
