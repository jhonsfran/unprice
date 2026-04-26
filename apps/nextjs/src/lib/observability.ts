import type { LogFields } from "@unprice/logs"
import {
  type AppLogger,
  type WideEventLogger,
  createAppLogger,
  createDrain,
} from "@unprice/observability"
import { createEvlog } from "evlog/next"
import { env } from "~/env"

const drain = createDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

export const { withEvlog, useLogger, log, createError, createEvlogError } = createEvlog({
  service: "nextjs",
  env: {
    environment: env.APP_ENV,
    region: env.VERCEL_REGION,
    version: env.VERCEL_DEPLOYMENT_ID ?? "unknown",
  },
  drain,
  // pretty: false,
  sampling: {
    rates: {
      info: env.APP_ENV === "production" ? 10 : 100,
      warn: 100,
      error: 100,
      debug: env.APP_ENV === "production" ? 0 : 100,
    },
    keep: [{ status: 400 }, { duration: 1000 }],
  },
})

export function getRequestLoggers(requestId?: string): {
  requestLogger: WideEventLogger
  logger: AppLogger
} {
  const requestLogger = useLogger<LogFields>()

  return {
    requestLogger,
    logger: createAppLogger(requestLogger, {
      flush: drain?.flush,
      requestId,
    }),
  }
}
