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

import { registerCreatePaymentMethodV1 } from "./routes/customer/createPaymentMethodV1"
import { registerGetEntitlementsV1 } from "./routes/customer/getEntitlementsV1"
import { registerGetPaymentMethodsV1 } from "./routes/customer/getPaymentMethodsV1"
import { registerGetSubscriptionV1 } from "./routes/customer/getSubscriptionV1"
import { registerSignUpV1 } from "./routes/customer/signUpV1"
import { registerVerifyV1 } from "./routes/customer/verifyV1"
import { registerIngestEventsSyncV1 } from "./routes/events/ingestEventsSyncV1"
import { registerIngestEventsV1 } from "./routes/events/ingestEventsV1"
import { registerGetLakehouseFilePlanV1 } from "./routes/lakehouse/getLakehouseFilePlanV1"
import { registerProviderSetupV1 } from "./routes/paymentProvider/providerSetupV1"
import { registerProviderSignUpV1 } from "./routes/paymentProvider/providerSignUpV1"
import { registerGetPlanVersionV1 } from "./routes/plans/getPlanVersionV1"
import { registerListPlanVersionsV1 } from "./routes/plans/listPlanVersionsV1"
import { registerGetFeaturesV1 } from "./routes/project/getFeaturesV1"

import { env } from "cloudflare:workers"
import type { IngestionQueueMessage } from "@unprice/services/ingestion"
import { timing } from "hono/timing"
import { verifyRealtimeTicket } from "~/auth/ticket"
import { consumeIngestionBatch } from "~/ingestion/service"
import { obs } from "~/middleware/obs"
import { apiEvlog } from "~/observability"
import { registerGetRealtimeTicketV1 } from "./routes/analitycs/getRealtimeTicketV1"
import { registerGetAnalyticsUsageV1 } from "./routes/analitycs/getUsageV1"
import { registerUpdateACLV1 } from "./routes/customer/updateACLV1"

const app = newApp()

app.use(timing())
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

// Customer routes
registerIngestEventsV1(app)
registerIngestEventsSyncV1(app)
registerGetEntitlementsV1(app)
registerVerifyV1(app)
registerGetSubscriptionV1(app)
registerGetPaymentMethodsV1(app)
registerSignUpV1(app)
registerCreatePaymentMethodV1(app)
registerUpdateACLV1(app)
// Project routes
registerGetFeaturesV1(app)

// Plans routes
registerGetPlanVersionV1(app)
registerListPlanVersionsV1(app)

// Payment provider routes
registerProviderSignUpV1(app)
registerProviderSetupV1(app)

// Analytics routes
registerGetAnalyticsUsageV1(app)
registerGetRealtimeTicketV1(app)

// Lakehouse routes
registerGetLakehouseFilePlanV1(app)

// Export handler
const handler = {
  fetch: (req: Request, env: Env, executionCtx: ExecutionContext) => {
    try {
      const parsedEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)

      return app.fetch(req, parsedEnv, executionCtx)
    } catch (error) {
      log.error({
        code: "BAD_ENVIRONMENT",
        error: error instanceof Error ? error : new Error(String(error ?? "Unknown error")),
      })
      return Response.json(
        {
          code: "BAD_ENVIRONMENT",
          message: "Some environment variables are missing or are invalid",
          errors: error instanceof Error ? error.message : "Unknown error",
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
    const parsedEnv = createRuntimeEnv(env as unknown as Record<string, unknown>)
    await consumeIngestionBatch(batch, parsedEnv, executionCtx)
  },
} satisfies ExportedHandler<Env, IngestionQueueMessage>

export default handler
