import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, getAllowedCorsOrigin } from "@unprice/config"
import { log } from "evlog"
import { partyserverMiddleware } from "hono-party"
import { cors } from "hono/cors"
import { type Env, createRuntimeEnv } from "~/env"
import { newApp } from "~/hono/app"
import { durableObjectJurisdiction } from "~/ingestion/do-placement"
import { init } from "~/middleware/init"

import serveEmojiFavicon from "stoker/middlewares/serve-emoji-favicon"

export { DurableObjectProject } from "~/project/do"
export { BudgetDO } from "~/ingestion/budget/BudgetDO"

import { registerUpdateACLV1 } from "./routes/access/updateACLV1"
import { registerExplainChargeV1 } from "./routes/analytics/explainChargeV1"
import { registerGetCurrentBillingPeriodUsageV1 } from "./routes/analytics/getCurrentBillingPeriodUsageV1"
import { registerGetIngestionStatusV1 } from "./routes/analytics/getIngestionStatusV1"
import { registerGetAnalyticsUsageV1 } from "./routes/analytics/getUsageV1"
import { registerAuthorizeBudgetV1 } from "./routes/budgets/authorizeBudgetV1"
import { registerChargeBudgetV1 } from "./routes/budgets/chargeBudgetV1"
import { registerCompletePayerStatementsInternalV1 } from "./routes/budgets/completePayerStatementsInternalV1"
import { registerGetBudgetV1 } from "./routes/budgets/getBudgetV1"
import { registerInspectBudgetInternalV1 } from "./routes/budgets/inspectBudgetInternalV1"
import { registerLeaseBudgetV1 } from "./routes/budgets/leaseBudgetV1"
import { registerModelsBudgetV1 } from "./routes/budgets/modelsBudgetV1"
import { registerRecordBudgetV1 } from "./routes/budgets/recordBudgetV1"
import { registerReleaseBudgetInternalV1 } from "./routes/budgets/releaseBudgetInternalV1"
import { registerReleaseBudgetV1 } from "./routes/budgets/releaseBudgetV1"
import { registerReportBudgetV1 } from "./routes/budgets/reportBudgetV1"
import { registerSealPayerStatementsInternalV1 } from "./routes/budgets/sealPayerStatementsInternalV1"
import { registerSettleBudgetV1 } from "./routes/budgets/settleBudgetV1"
import { registerSyncPayerBudgetInternalV1 } from "./routes/budgets/syncPayerBudgetInternalV1"
import { registerUpsertBudgetV1 } from "./routes/budgets/upsertBudgetV1"
import { registerChangePlanV1 } from "./routes/customers/changePlanV1"
import { registerSignUpV1 } from "./routes/customers/signUpV1"
import { registerGetCurrentEntitlementsV1 } from "./routes/entitlements/getCurrentEntitlementsV1"
import { registerGetEntitlementsV1 } from "./routes/entitlements/getEntitlementsV1"
import { registerVerifyV1 } from "./routes/entitlements/verifyV1"
import { registerGetFeaturesV1 } from "./routes/features/getFeaturesV1"
import { registerApplyMonetizationV1 } from "./routes/monetization/applyMonetizationV1"
import { registerGetMonetizationV1 } from "./routes/monetization/getMonetizationV1"
import { registerCreatePaymentMethodV1 } from "./routes/payments/methods/createPaymentMethodV1"
import { registerListPaymentMethodsV1 } from "./routes/payments/methods/listPaymentMethodsV1"
import { registerProviderSetupV1 } from "./routes/payments/providers/providerSetupV1"
import { registerProviderSignUpV1 } from "./routes/payments/providers/providerSignUpV1"
import { registerProviderStripeConnectWebhookV1 } from "./routes/payments/providers/providerStripeConnectWebhookV1"
import { registerProviderWebhookV1 } from "./routes/payments/providers/providerWebhookV1"
import { registerGetPlanVersionV1 } from "./routes/plans/getPlanVersionV1"
import { registerListPlanVersionsV1 } from "./routes/plans/listPlanVersionsV1"
import { registerGetSubscriptionV1 } from "./routes/subscriptions/getSubscriptionV1"
import { registerConsumeUsageV1 } from "./routes/usage/consumeUsageV1"
import { registerRecordUsageV1 } from "./routes/usage/recordUsageV1"

import { env } from "cloudflare:workers"
import { timing } from "hono/timing"
import { verifyRealtimeTicket } from "~/auth/ticket"
import { serializeError } from "~/errors/log"
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
      // DurableObjectProject is addressed by partyserver, not by our own
      // getByName, so this is the only place its placement can be set. It
      // holds ephemeral broadcast state, but leaving it outside the EU would
      // make the residency claim on the landing page false. Resolves to
      // undefined locally — workerd rejects jurisdictions outright. See
      // ingestion/do-placement.ts.
      jurisdiction: durableObjectJurisdiction(env.APP_ENV),
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

// Budget routes
registerUpsertBudgetV1(app)
registerAuthorizeBudgetV1(app)
registerSettleBudgetV1(app)
registerReleaseBudgetV1(app)
registerChargeBudgetV1(app)
registerRecordBudgetV1(app)
registerGetBudgetV1(app)
registerLeaseBudgetV1(app)
registerReportBudgetV1(app)
registerModelsBudgetV1(app)

// Billing routes
registerSyncPayerBudgetInternalV1(app)
registerSealPayerStatementsInternalV1(app)
registerCompletePayerStatementsInternalV1(app)

// Dashboard routes
registerInspectBudgetInternalV1(app)
registerReleaseBudgetInternalV1(app)

// Customer routes
registerSignUpV1(app)
registerChangePlanV1(app)

// Entitlement routes
registerGetEntitlementsV1(app)
registerGetCurrentEntitlementsV1(app)
registerVerifyV1(app)

// Usage routes: every event goes to its customer's payer budget (ADR-0008 D6)
registerRecordUsageV1(app)
registerConsumeUsageV1(app)

// Feature routes
registerGetFeaturesV1(app)

// Invoice routes
registerGetInvoiceV1(app)

// Monetization configuration routes
registerApplyMonetizationV1(app)
registerGetMonetizationV1(app)

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

// Usage analytics routes
registerExplainChargeV1(app)
registerGetIngestionStatusV1(app)
registerGetAnalyticsUsageV1(app)
registerGetCurrentBillingPeriodUsageV1(app)

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
} satisfies ExportedHandler<Env>

export default handler
