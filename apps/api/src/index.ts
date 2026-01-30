import { partyserverMiddleware } from "hono-party"
import { cors } from "hono/cors"
import { type Env, createRuntimeEnv } from "~/env"
import { newApp } from "~/hono/app"
import { init } from "~/middleware/init"

import serveEmojiFavicon from "stoker/middlewares/serve-emoji-favicon"

export { DurableObjectUsagelimiter } from "~/usagelimiter/do"
export { DurableObjectProject } from "~/project/do"

import { registerReportUsageV1 } from "~/routes/customer/reportUsageV1"
import { registerCanV1 } from "./routes/customer/canV1"
import { registerCreatePaymentMethodV1 } from "./routes/customer/createPaymentMethodV1"
import { registerGetEntitlementsV1 } from "./routes/customer/getEntitlementsV1"
import { registerGetPaymentMethodsV1 } from "./routes/customer/getPaymentMethodsV1"
import { registerGetSubscriptionV1 } from "./routes/customer/getSubscriptionV1"
import { registerGetUsageV1 } from "./routes/customer/getUsageV1"
import { registerResetEntitlementsV1 } from "./routes/customer/resetEntitlementsV1"
import { registerSignUpV1 } from "./routes/customer/signUpV1"
import { registerStripeSetupV1 } from "./routes/paymentProvider/stripeSetupV1"
import { registerStripeSignUpV1 } from "./routes/paymentProvider/stripeSignUpV1"
import { registerGetPlanVersionV1 } from "./routes/plans/getPlanVersionV1"
import { registerListPlanVersionsV1 } from "./routes/plans/listPlanVersionsV1"
import { registerGetFeaturesV1 } from "./routes/project/getFeaturesV1"

import { env } from "cloudflare:workers"
import { getToken } from "@auth/core/jwt"
import { ConsoleLogger } from "@unprice/logging"
import { timing } from "hono/timing"
import { obs } from "~/middleware/obs"
import { registerGetAnalyticsUsageV1 } from "./routes/analitycs/getUsageV1"
import { registerGetAnalyticsVerificationsV1 } from "./routes/analitycs/getVerificationsV1"
import { registerUpdateACLV1 } from "./routes/customer/updateACLV1"

const app = newApp()

app.use(timing())
app.use(serveEmojiFavicon("◎"))
app.use("*", cors())
app.use("*", init())
app.use("*", obs())

// Handle websocket connections for Durable Objects
app.use(
  "/broadcast/**",
  partyserverMiddleware({
    onError: (error) => console.error(error),
    options: {
      prefix: "broadcast",
      onBeforeConnect: async (req) => {
        const url = new URL(req.url)

        const sessionToken = url.searchParams.get("sessionToken")

        const sessionName =
          env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token"

        // set the req cookie
        req.headers.set("cookie", `${sessionName}=${sessionToken}`)

        const token = await getToken({
          req,
          secret: env.AUTH_SECRET,
          raw: false,
          salt: sessionName,
          secureCookie: env.NODE_ENV === "production",
        })

        if (!token) return new Response("Unauthorized", { status: 401 })

        // validate exp
        if (token?.exp && token.exp < Date.now() / 1000) {
          return new Response("Unauthorized", { status: 401 })
        }

        const userId = token?.id as string | undefined

        // if id doesn't start with "usr_" throw an error
        if (!userId?.startsWith("usr_")) {
          return new Response("Unauthorized", { status: 401 })
        }
      },
    },
  })
)

// Customer routes
registerReportUsageV1(app)
registerGetEntitlementsV1(app)
registerCanV1(app)
registerGetSubscriptionV1(app)
registerGetUsageV1(app)
registerGetPaymentMethodsV1(app)
registerSignUpV1(app)
registerCreatePaymentMethodV1(app)
registerResetEntitlementsV1(app)
registerUpdateACLV1(app)

// Project routes
registerGetFeaturesV1(app)

// Plans routes
registerGetPlanVersionV1(app)
registerListPlanVersionsV1(app)

// Payment provider routes
registerStripeSignUpV1(app)
registerStripeSetupV1(app)

// Analytics routes
registerGetAnalyticsUsageV1(app)
registerGetAnalyticsVerificationsV1(app)

// Export handler
const handler = {
  fetch: (req: Request, env: Env, executionCtx: ExecutionContext) => {
    try {
      const parsedEnv = createRuntimeEnv(
        env as unknown as Record<string, string | number | boolean>
      )

      return app.fetch(req, parsedEnv, executionCtx)
    } catch (error) {
      new ConsoleLogger({
        requestId: "",
        environment: env.NODE_ENV,
        service: "api",
      }).fatal(`BAD_ENVIRONMENT: ${error instanceof Error ? error.message : "Unknown error"}`)
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
} satisfies ExportedHandler<Env>

export default handler
