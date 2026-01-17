import { env } from "cloudflare:workers"
import { OpenAPIHono } from "@hono/zod-openapi"
import { apiReference } from "@scalar/hono-api-reference"
import type { Context as GenericContext } from "hono"
import { prettyJSON } from "hono/pretty-json"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import { getStats } from "~/util/stats"

export function newApp() {
  const app = new OpenAPIHono<HonoEnv>({
    defaultHook: handleZodError,
  })

  // TODO: rename vercel env to env (it's funny using it in cloudflare workers)
  if (env.VERCEL_ENV !== "production") {
    app.use(prettyJSON())
  }

  app.onError(handleError)

  app.use("*", async (c, next) => {
    // Set analytics here to have access to browser info
    c.set("stats", getStats(c))
    return next()
  })

  const servers = [
    {
      url: "https://api.unprice.dev",
      description: "Production",
    },
    {
      url: "http://localhost:8787",
      description: "Development",
    },
    {
      url: "https://preview-api.unprice.dev",
      description: "Preview",
    },
  ]

  app.doc("/openapi.json", {
    openapi: "3.0.3",
    info: {
      title: "Unprice API",
      version: "1.0.0",
    },
    servers:
      env.VERCEL_ENV === "production"
        ? [
            {
              url: "https://api.unprice.dev",
              description: "Production",
            },
          ]
        : servers,
    "x-speakeasy-retries": {
      strategy: "backoff",
      backoff: {
        initialInterval: 50, // 50ms
        maxInterval: 1_000, // 1s
        maxElapsedTime: 30_000, // 30s
        exponent: 1.5,
      },
      statusCodes: ["5XX"],
      retryConnectionErrors: true,
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  })

  app.get(
    "/reference",
    apiReference({
      title: "Unprice API",
      layout: "classic",
      defaultHttpClient: {
        targetKey: "shell",
        clientKey: "curl",
      },
      pageTitle: "Unprice API",
      theme: "deepSpace",
      url: "/openapi.json",
      authentication: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "root key",
      },
    })
  )

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    bearerFormat: "root key",
    type: "http",
    scheme: "bearer",
    "x-speakeasy-example": "UNPRICE_API_KEY",
  })

  return app
}

export type App = ReturnType<typeof newApp>
export type Context = GenericContext<HonoEnv>
