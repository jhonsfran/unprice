import type { Logger } from "@unprice/logs"
import { createLogger, createUnpriceDrain, sharedSamplingConfig } from "@unprice/observability"
import { waitUntil } from "@vercel/functions"
import type { DrainContext, RequestLogger } from "evlog"
import { createEvlog } from "evlog/next"
import { env } from "~/env"

// ============================================
// Single drain for the Next.js runtime
// ============================================

const axiomDrain = createUnpriceDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

// Wrap the drain to schedule flush via waitUntil after each event
const drain =
  axiomDrain &&
  ((ctx: DrainContext) => {
    axiomDrain(ctx)
    waitUntil(axiomDrain.flush())
  })

// ============================================
// evlog/next integration
// ============================================

export const { withEvlog, useLogger, log, createError, createEvlogError } = createEvlog({
  service: "nextjs",
  env: {
    environment: env.APP_ENV,
    region: env.VERCEL_REGION,
    version: env.VERCEL_DEPLOYMENT_ID ?? "unknown",
  },
  ...(drain ? { drain } : {}),
  sampling: sharedSamplingConfig(env.APP_ENV),
})

// ============================================
// Helper to get typed logger from evlog/next context
// ============================================

export function getRequestLoggers(_requestId?: string): {
  requestLogger: RequestLogger<Record<string, unknown>>
  logger: Logger
} {
  const requestLogger = useLogger<Record<string, unknown>>()
  return {
    requestLogger,
    logger: createLogger(requestLogger, {
      flush: axiomDrain?.flush,
    }),
  }
}
