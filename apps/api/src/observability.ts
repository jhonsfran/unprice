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

const DEFAULT_DO_LOG_SAMPLE_RATE = 0.1

export function resolveDoLogSampleRate(raw: string | undefined): number {
  const normalized = raw?.trim()
  if (!normalized) return DEFAULT_DO_LOG_SAMPLE_RATE

  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_DO_LOG_SAMPLE_RATE
  }
  return parsed
}

/**
 * DO diagnostics that must never be sampled away: errors, business denials,
 * batches containing denials, and operator-recovery states. Everything else
 * is throughput telemetry and is safe to sample (multiply counts by
 * 1/sample_rate in Axiom).
 */
export function shouldAlwaysKeepDoLogEvent(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false
  if (fields.outcome === "error") return true
  if (fields.error !== undefined && fields.error !== null) return true
  if (typeof fields.error_message === "string" && fields.error_message.length > 0) return true
  if (fields.allowed === false) return true
  if (typeof fields.denied_reason === "string" && fields.denied_reason.length > 0) return true
  if (typeof fields.denied_count === "number" && fields.denied_count > 0) return true
  if (fields.recovery_required === true) return true
  return false
}

const doLogSampleRate = resolveDoLogSampleRate(
  (env as unknown as Record<string, unknown>).DO_LOG_SAMPLE_RATE as string | undefined
)

function shouldEmitDoInfoEvent(fields: Record<string, unknown> | undefined): boolean {
  if (shouldAlwaysKeepDoLogEvent(fields)) return true
  if (doLogSampleRate >= 1) return true
  if (doLogSampleRate <= 0) return false
  return Math.random() < doLogSampleRate
}

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
      const event = {
        ...buildDoLogFields(context, fields),
        level: "debug",
        sample_rate: doLogSampleRate,
      }
      if (!shouldEmitDoInfoEvent(event)) return
      apiMetricsLogger.info(message, event)
    },
    info(message, fields) {
      const event = {
        ...buildDoLogFields(context, fields),
        sample_rate: doLogSampleRate,
      }
      if (!shouldEmitDoInfoEvent(event)) return
      apiMetricsLogger.info(message, event)
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
