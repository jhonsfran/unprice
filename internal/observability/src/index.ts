import type { Logger } from "@unprice/logs"
import {
  type DrainContext,
  type LoggerConfig,
  type RequestLogger,
  type RequestLoggerOptions,
  createRequestLogger,
  log as evlogGlobal,
  getEnvironment,
  initLogger,
} from "evlog"
import { createDrainPipeline } from "evlog/pipeline"

// ============================================
// Re-exports
// ============================================

export type { Logger } from "@unprice/logs"
export type { WideEventInput } from "@unprice/logs"
export type { RequestLogger, DrainContext } from "evlog"

// ============================================
// Types
// ============================================

export type UnpriceDrain = ((ctx: DrainContext) => void) & {
  flush: () => Promise<void>
  pending: number
}

type DrainOptions = {
  token?: string
  dataset?: string
  environment?: string
  orgId?: string
}

type SamplingConfig = NonNullable<LoggerConfig["sampling"]>

type AxiomEvent = Record<string, unknown>

const REQUEST_ALIASES = {
  requestId: "request_id",
  method: "request_method",
  path: "request_path",
  route: "request_route",
  status: "request_status",
  duration: "request_duration",
} as const

const BUSINESS_ALIASES = {
  customerId: "customer_id",
  featureSlug: "feature_slug",
  projectId: "project_id",
  unpriceCustomerId: "unprice_customer_id",
  userId: "user_id",
  workspaceId: "workspace_id",
} as const

const TOP_LEVEL_ALIASES = {
  ...REQUEST_ALIASES,
  ...BUSINESS_ALIASES,
} as const

// ============================================
// Shared sampling config
// ============================================

export function sharedSamplingConfig(environment?: string): SamplingConfig {
  const isDev = environment === "development"
  return {
    rates: {
      info: isDev ? 100 : 1, // 1% in non dev, 100% in dev
      warn: 100,
      error: 100,
      debug: isDev ? 100 : 0,
    },
    keep: [{ status: 400 }, { duration: 700 }], // 700ms slow request threshold
  }
}

// ============================================
// Axiom drain (fetch-based, works in all runtimes including Workers)
// ============================================

const AXIOM_INGEST_URL = "https://api.axiom.co/v1/datasets"
const AXIOM_TIMEOUT_MS = 5_000

function createAxiomFetchDrain(opts: {
  dataset: string
  token: string
  orgId?: string
}): (batch: DrainContext[]) => Promise<void> {
  const url = `${AXIOM_INGEST_URL}/${encodeURIComponent(opts.dataset)}/ingest`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
  }
  if (opts.orgId) {
    headers["X-Axiom-Org-Id"] = opts.orgId
  }

  return async (batch) => {
    if (batch.length === 0) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), AXIOM_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(batch.map((ctx) => normalizeAxiomEvent(ctx.event))),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Axiom ingest failed (${response.status}): ${body.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function normalizeAxiomEvent(event: AxiomEvent): AxiomEvent {
  const normalized: AxiomEvent = {}

  for (const [key, value] of Object.entries(event)) {
    if (isPlainRecord(value) || key in TOP_LEVEL_ALIASES) {
      continue
    }

    setIfAbsent(normalized, toSnakeCase(key), value)
  }

  for (const [key, value] of Object.entries(event)) {
    const normalizedKey =
      TOP_LEVEL_ALIASES[key as keyof typeof TOP_LEVEL_ALIASES] ?? toSnakeCase(key)

    if (isPlainRecord(value)) {
      flattenAxiomFields(normalized, getNamespacePrefix(normalizedKey), value)
      continue
    }

    setIfAbsent(normalized, normalizedKey, value)
  }

  return normalized
}

function getNamespacePrefix(key: string): string {
  return key === "business" ? "" : key
}

function flattenAxiomFields(
  target: AxiomEvent,
  prefix: string,
  fields: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(fields)) {
    const fieldKey = [prefix, toSnakeCase(key)].filter(Boolean).join("_")

    if (isPlainRecord(value)) {
      flattenAxiomFields(target, fieldKey, value)
      continue
    }

    setIfAbsent(target, fieldKey, value)
  }
}

function setIfAbsent(target: AxiomEvent, key: string, value: unknown): void {
  if (target[key] === undefined && value !== undefined) {
    target[key] = value
  }
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

// ============================================
// Drain: fetch-based Axiom + evlog/pipeline batching
// ============================================

export function createUnpriceDrain(options: DrainOptions): UnpriceDrain | undefined {
  const token = options.token?.trim()
  const dataset = options.dataset?.trim()

  if (!token || !dataset || options.environment === "development") {
    return undefined
  }

  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5_000 },
    retry: { maxAttempts: 3 },
  })

  const axiomDrain = createAxiomFetchDrain({ dataset, token, orgId: options.orgId })
  return pipeline(axiomDrain) as UnpriceDrain
}

// ============================================
// Init: thin wrapper over evlog's initLogger
// ============================================

export function initObservability(config?: LoggerConfig): void {
  initLogger(config)
}

// ============================================
// Metrics logger: pushes directly to drain without requestLogs accumulation
// ============================================

/**
 * Creates a lightweight logger for metrics emission.
 *
 * Unlike `createLogger` (which wraps a request-scoped evlog RequestLogger and
 * accumulates every `.info()` call in `requestLogs` with O(n) array copies),
 * this logger pushes each metric event directly to the drain pipeline.
 *
 * Use this for `LogdrainMetrics` so metric emissions don't bloat the
 * request-scoped wide event or cause quadratic memory growth.
 */
export function createMetricsLogger(drain?: UnpriceDrain): Logger {
  return {
    set() {},
    debug() {},
    info(message, fields) {
      if (!drain) return
      const env = getEnvironment()
      drain({
        event: {
          ...env,
          timestamp: new Date().toISOString(),
          level: "info" as const,
          type: "metric",
          message,
          ...fields,
        },
      })
    },
    warn(message, fields) {
      if (!drain) return
      const env = getEnvironment()
      drain({
        event: {
          ...env,
          timestamp: new Date().toISOString(),
          level: "warn" as const,
          type: "metric",
          message,
          ...fields,
        },
      })
    },
    error(message, fields) {
      if (!drain) return
      const env = getEnvironment()
      drain({
        event: {
          ...env,
          timestamp: new Date().toISOString(),
          level: "error" as const,
          type: "metric",
          message: message instanceof Error ? message.message : String(message),
          ...fields,
        },
      })
    },
    flush() {
      return drain?.flush() ?? Promise.resolve()
    },
  }
}

// ============================================
// Logger factory: wraps evlog RequestLogger into the Logger interface
// ============================================

export function createLogger(
  requestLogger: RequestLogger<Record<string, unknown>>,
  options?: { flush?: () => Promise<void> }
): Logger {
  return {
    set(fields) {
      requestLogger.set(fields)
    },
    debug(message, fields) {
      evlogGlobal.debug({ message, ...fields })
    },
    info(message, fields) {
      requestLogger.info(message, fields)
    },
    warn(message, fields) {
      requestLogger.warn(message, fields)
    },
    error(message, fields) {
      if (message instanceof Error) {
        requestLogger.error(message, fields)
      } else if (typeof message === "string") {
        requestLogger.error(message, fields)
      } else {
        requestLogger.error(new Error(String(message ?? "Unknown error")), fields)
      }
    },
    flush() {
      return options?.flush?.() ?? Promise.resolve()
    },
  }
}

// ============================================
// Standalone request logger (for contexts without framework middleware)
// ============================================

export function createStandaloneRequestLogger(
  options?: RequestLoggerOptions,
  adapterOptions?: { flush?: () => Promise<void> }
): {
  requestLogger: RequestLogger<Record<string, unknown>>
  logger: Logger
} {
  const requestLogger = createRequestLogger<Record<string, unknown>>(options)
  return {
    requestLogger,
    logger: createLogger(requestLogger, adapterOptions),
  }
}

// ============================================
// DO operation wrapper
// ============================================

export async function runDoOperation<T>(
  params: {
    requestId: string
    service: string
    operation: string
    baseFields?: Record<string, unknown>
    waitUntil?: (promise: Promise<unknown>) => void
    drain?: UnpriceDrain
  },
  fn: (logger: Logger) => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  const requestLogger = createRequestLogger<Record<string, unknown>>({
    requestId: params.requestId,
  })

  const logger = createLogger(requestLogger, { flush: params.drain?.flush })

  logger.set({
    service: params.service,
    operation: params.operation,
    request: {
      id: params.requestId,
      timestamp: new Date(startedAt).toISOString(),
      path: `/durable-objects/${params.service}/${params.operation}`,
    },
    cloud: {
      platform: "cloudflare",
      durable_object_id: params.requestId,
    },
    business: extractBusinessFields(params.operation, params.baseFields),
    ...(params.baseFields ?? {}),
  })

  let thrown: unknown
  try {
    return await fn(logger)
  } catch (err) {
    thrown = err
    logger.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  } finally {
    const duration = Date.now() - startedAt
    const status = thrown ? 500 : 200

    requestLogger.set({ status, duration, request: { status, duration } })
    requestLogger.emit({ status, duration, request: { status, duration } })

    if (params.drain) {
      params.waitUntil?.(params.drain.flush())
    }
  }
}

function extractBusinessFields(
  operation: string,
  baseFields?: Record<string, unknown>
): Record<string, unknown> {
  const KEYS = [
    "customer_id",
    "feature_slug",
    "is_internal",
    "is_main",
    "project_id",
    "unprice_customer_id",
    "workspace_id",
  ] as const

  const business: Record<string, unknown> = { operation }

  for (const key of KEYS) {
    const value = baseFields?.[key]
    if (value !== undefined && value !== null) {
      business[key] = value
    }
  }

  return business
}

// ============================================
// Env helpers (kept for backward compat)
// ============================================

export function shouldEmitMetrics(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV !== "development"
}
