import { env } from "cloudflare:workers"
import {
  type AppLogger,
  createAppLogger,
  createDrain,
  initObservability,
} from "@unprice/observability"
import type { WideEventLogger } from "@unprice/observability"
import { evlog } from "evlog/hono"

export const apiDrain = createDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

initObservability({
  env: {
    service: "api",
    environment: env.APP_ENV,
    version: env.VERSION ?? "unknown",
  },
  drain: apiDrain,
  sampling: {
    rates: {
      info: env.APP_ENV === "production" ? 10 : 100,
      warn: 100,
      error: 100,
      debug: env.APP_ENV === "production" ? 0 : 100,
    },
    keep: [{ status: 400 }, { duration: 1000 }], // keep >= 400 status codes and requests that take longer than 1 second
  },
})

export const apiEvlog = evlog()

export function createApiLogger(requestLogger: WideEventLogger, requestId?: string): AppLogger {
  return createAppLogger(requestLogger, {
    flush: apiDrain?.flush,
    requestId,
  })
}
