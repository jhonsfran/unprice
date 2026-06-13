import { env } from "cloudflare:workers"
import type { Logger } from "@unprice/logs"
import {
  runDoOperation as _runDoOperation,
  createLogger,
  createMetricsLogger,
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

/**
 * Metrics logger: pushes metric events directly to the drain pipeline
 * without accumulating in the request-scoped requestLogs array.
 */
export const apiMetricsLogger: Logger = createMetricsLogger(apiDrain)

export function createDoLogger(requestId: string): Logger {
  let context: Record<string, unknown> = {
    requestId,
    request: { id: requestId },
    cloud: {
      platform: "cloudflare",
      durable_object_id: requestId,
    },
  }

  return {
    set(fields) {
      context = mergeLogFields(context, fields)
    },
    debug(message, fields) {
      apiMetricsLogger.info(message, { ...buildDoLogFields(context, fields), level: "debug" })
    },
    info(message, fields) {
      apiMetricsLogger.info(message, buildDoLogFields(context, fields))
    },
    warn(message, fields) {
      apiMetricsLogger.warn(message, buildDoLogFields(context, fields))
    },
    error(message, fields) {
      apiMetricsLogger.error(message, buildDoErrorFields(message, context, fields))
    },
    flush() {
      return apiMetricsLogger.flush()
    },
  }
}

function buildDoLogFields(
  context: Record<string, unknown>,
  fields?: Record<string, unknown>
): Record<string, unknown> {
  return mergeLogFields(
    {
      type: "log",
      ...context,
    },
    fields ?? {}
  )
}

function buildDoErrorFields(
  message: unknown,
  context: Record<string, unknown>,
  fields?: Record<string, unknown>
): Record<string, unknown> {
  const error = normalizeError(message, fields)
  return mergeLogFields(buildDoLogFields(context, fields), error ? { error } : {})
}

function normalizeError(
  message: unknown,
  fields?: Record<string, unknown>
): {
  message: string
  name: string
  stack?: string
} | null {
  if (message instanceof Error) {
    return {
      message: message.message,
      name: message.name,
      stack: message.stack,
    }
  }

  const maybeError = fields?.error
  if (maybeError instanceof Error) {
    return {
      message: maybeError.message,
      name: maybeError.name,
      stack: maybeError.stack,
    }
  }

  return null
}

function mergeLogFields(
  base: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...base,
    ...next,
    business: mergeObjects(base.business, next.business),
    cloud: mergeObjects(base.cloud, next.cloud),
    request: mergeObjects(base.request, next.request),
  }
}

function mergeObjects(left: unknown, right: unknown): unknown {
  if (!isRecord(left)) return right
  if (!isRecord(right)) return left
  return { ...left, ...right }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
