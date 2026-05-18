import { env } from "cloudflare:workers"
import type { Logger } from "@unprice/logs"
import {
  runDoOperation as _runDoOperation,
  createLogger,
  createStandaloneRequestLogger,
  createUnpriceDrain,
  initObservability,
  sharedSamplingConfig,
} from "@unprice/observability"
import { evlog } from "evlog/hono"

// ============================================
// Single drain for the entire API worker
// ============================================

export const apiDrain = createUnpriceDrain({
  environment: env.APP_ENV,
  token: env.AXIOM_API_TOKEN,
  dataset: env.AXIOM_DATASET,
})

// ============================================
// Init evlog global (once per isolate)
// ============================================

initObservability({
  env: {
    service: "api",
    environment: env.APP_ENV,
    version: env.VERSION ?? "unknown",
  },
  drain: apiDrain,
  sampling: sharedSamplingConfig(env.APP_ENV),
})

// ============================================
// Hono middleware (evlog/hono does request lifecycle)
// ============================================

export const apiEvlog = evlog()

// ============================================
// Helpers for route handlers and DOs
// ============================================

export function createApiLogger(
  requestLogger: Parameters<typeof createLogger>[0],
  _requestId?: string
): Logger {
  return createLogger(requestLogger, { flush: apiDrain?.flush })
}

export function createDoLogger(requestId: string): Logger {
  const { logger } = createStandaloneRequestLogger({ requestId }, { flush: apiDrain?.flush })
  return logger
}

/**
 * Wraps @unprice/observability's runDoOperation, injecting the API drain.
 * DOs call this without needing to know about the drain.
 */
export function runDoOperation<T>(
  params: {
    requestId: string
    service: string
    operation: string
    baseFields?: Record<string, unknown>
    waitUntil?: (promise: Promise<unknown>) => void
  },
  fn: (logger: Logger) => Promise<T>
): Promise<T> {
  return _runDoOperation({ ...params, drain: apiDrain ?? undefined }, fn)
}
