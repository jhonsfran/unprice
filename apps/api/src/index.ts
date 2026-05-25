import { log } from "evlog"
import { partyserverMiddleware } from "hono-party"
import { cors } from "hono/cors"
import { type Env, createRuntimeEnv } from "~/env"
import { newApp } from "~/hono/app"
import { init } from "~/middleware/init"

import serveEmojiFavicon from "stoker/middlewares/serve-emoji-favicon"

export { DurableObjectProject } from "~/project/do"
export { IngestionAuditDO } from "~/ingestion/audit/IngestionAuditDO"
export { EntitlementWindowDO } from "~/ingestion/entitlements/EntitlementWindowDO"

import { registerUpdateACLV1 } from "./routes/access/updateACLV1"
import { registerGetAnalyticsUsageV1 } from "./routes/analytics/getUsageV1"
import { registerSignUpV1 } from "./routes/customers/signUpV1"
import { registerGetEntitlementWindowStatusV1 } from "./routes/entitlements/getEntitlementWindowStatusV1"
import { registerGetEntitlementsV1 } from "./routes/entitlements/getEntitlementsV1"
import { registerVerifyV1 } from "./routes/entitlements/verifyV1"
import { registerIngestEventsSyncV1 } from "./routes/events/ingestEventsSyncV1"
import { registerIngestEventsV1 } from "./routes/events/ingestEventsV1"
import { registerGetFeaturesV1 } from "./routes/features/getFeaturesV1"
import { registerGetLakehouseFilePlanV1 } from "./routes/lakehouse/getLakehouseFilePlanV1"
import { registerCreatePaymentMethodV1 } from "./routes/payments/methods/createPaymentMethodV1"
import { registerListPaymentMethodsV1 } from "./routes/payments/methods/listPaymentMethodsV1"
import { registerProviderSetupV1 } from "./routes/payments/providers/providerSetupV1"
import { registerProviderSignUpV1 } from "./routes/payments/providers/providerSignUpV1"
import { registerProviderStripeConnectWebhookV1 } from "./routes/payments/providers/providerStripeConnectWebhookV1"
import { registerProviderWebhookV1 } from "./routes/payments/providers/providerWebhookV1"
import { registerGetPlanVersionV1 } from "./routes/plans/getPlanVersionV1"
import { registerListPlanVersionsV1 } from "./routes/plans/listPlanVersionsV1"
import { registerGetRealtimeTicketV1 } from "./routes/realtime/getRealtimeTicketV1"
import { registerGetSubscriptionV1 } from "./routes/subscriptions/getSubscriptionV1"

import { env } from "cloudflare:workers"
import type { IngestionQueueMessage } from "@unprice/services/ingestion"
import { timing } from "hono/timing"
import { verifyRealtimeTicket } from "~/auth/ticket"
import { serializeError } from "~/errors/log"
import { consumeIngestionBatch } from "~/ingestion/service"
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
app.use("*", cors())
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
          const payload = await verifyRealtimeTicket({
            token: ticket,
            secret: env.AUTH_SECRET,
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

// Access routes
registerUpdateACLV1(app)

// Customer routes
registerSignUpV1(app)

// Entitlement routes
registerGetEntitlementsV1(app)
registerVerifyV1(app)

// Event routes
registerIngestEventsV1(app)
registerIngestEventsSyncV1(app)
registerGetEntitlementWindowStatusV1(app)

// Feature routes
registerGetFeaturesV1(app)

// Invoice routes
registerGetInvoiceV1(app)

// Lakehouse routes
registerGetLakehouseFilePlanV1(app)

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

// Realtime routes
registerGetRealtimeTicketV1(app)

// Subscription routes
registerGetSubscriptionV1(app)

// Usage routes
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
    batch: MessageBatch<IngestionQueueMessage>,
    env: Env,
    executionCtx: ExecutionContext
  ) => {
    try {
      const parsedEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)
      await consumeIngestionBatch(batch, parsedEnv, executionCtx, apiDrain ?? undefined)
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
} satisfies ExportedHandler<Env, IngestionQueueMessage>

export default handler
