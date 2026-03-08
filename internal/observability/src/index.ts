import { AsyncLocalStorage } from "node:async_hooks"
import type { LogContext, LogFields, LogMetadata, Logger } from "@unprice/logs"
import {
  type DrainContext,
  type FieldContext,
  type LoggerConfig,
  type RequestLogger,
  type RequestLoggerOptions,
  createRequestLogger as createEvlogRequestLogger,
  log as evlog,
  initLogger,
} from "evlog"
import { createDrainPipeline } from "evlog/pipeline"

export type WideEventLogger = RequestLogger<LogFields>
export type AppLogger = Logger & {
  emit(level: "debug" | "info" | "warn" | "error", message: string, fields?: LogMetadata): void
  fatal(message: string, fields?: LogMetadata): void
}

type FlushableDrain = ((ctx: DrainContext) => void | Promise<void>) & {
  flush?: () => Promise<void>
}

type AxiomDrainOptions = {
  baseUrl?: string
  dataset: string
  edgeUrl?: string
  orgId?: string
  timeoutMs?: number
  token: string
}

type LoggerScope = {
  requestId?: string
  requestLogger: WideEventLogger
}

function createStorageAdapter<T>(): {
  getStore: () => T | undefined
  run: <R>(store: T, fn: () => R) => R
} {
  const storage = new AsyncLocalStorage<T>()

  return {
    getStore: () => storage.getStore(),
    run: (store, fn) => storage.run(store, fn),
  }
}

const loggerScopeStorage = createStorageAdapter<LoggerScope>()

const DEFAULT_AXIOM_BASE_URL = "https://api.axiom.co"
const DEFAULT_AXIOM_TIMEOUT_MS = 5000

export function initObservability(config?: LoggerConfig): void {
  initLogger(config)
}

export function createDrain(options: {
  environment?: string
  baseUrl?: string
  token?: string
  dataset?: string
  edgeUrl?: string
  orgId?: string
  timeoutMs?: number
}): FlushableDrain | undefined {
  if (!options.token || !options.dataset || options.environment === "development") {
    return undefined
  }

  const pipeline = createDrainPipeline<DrainContext>({
    batch: {
      size: 50,
      intervalMs: 5000,
    },
    retry: {
      maxAttempts: 3,
    },
  })

  return pipeline(
    createAxiomDrain({
      baseUrl: options.baseUrl,
      dataset: options.dataset,
      edgeUrl: options.edgeUrl,
      orgId: options.orgId,
      timeoutMs: options.timeoutMs,
      token: options.token,
    })
  )
}

function createAxiomDrain(options: AxiomDrainOptions): (batch: DrainContext[]) => Promise<void> {
  return async (batch) => {
    if (batch.length === 0) {
      return
    }

    const controller = typeof AbortController === "undefined" ? undefined : new AbortController()
    const timeoutId =
      controller && options.timeoutMs !== 0
        ? setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_AXIOM_TIMEOUT_MS)
        : undefined

    try {
      const response = await fetch(resolveAxiomIngestUrl(options), {
        method: "POST",
        headers: createAxiomHeaders(options),
        body: JSON.stringify(batch.map((ctx) => ctx.event)),
        signal: controller?.signal,
      })

      if (response.ok) {
        return
      }

      const responseBody = await response.text().catch(() => "")
      const suffix = responseBody ? `: ${responseBody.slice(0, 500)}` : ""

      throw new Error(`Axiom drain failed (${response.status} ${response.statusText})${suffix}`)
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    }
  }
}

function createAxiomHeaders(options: AxiomDrainOptions): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  }

  if (options.orgId) {
    headers["X-Axiom-Org-Id"] = options.orgId
  }

  return headers
}

function resolveAxiomIngestUrl(options: AxiomDrainOptions): string {
  const encodedDataset = encodeURIComponent(options.dataset)

  if (!options.edgeUrl) {
    return `${normalizeBaseUrl(options.baseUrl)}/v1/datasets/${encodedDataset}/ingest`
  }

  try {
    const parsedUrl = new URL(options.edgeUrl)

    if (parsedUrl.pathname === "" || parsedUrl.pathname === "/") {
      parsedUrl.pathname = `/v1/ingest/${encodedDataset}`
      return parsedUrl.toString()
    }

    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "")
    return parsedUrl.toString()
  } catch {
    return `${options.edgeUrl.replace(/\/+$/, "")}/v1/ingest/${encodedDataset}`
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_AXIOM_BASE_URL).replace(/\/+$/, "")
}

function resolveLoggerScope(
  fallbackRequestLogger: WideEventLogger,
  fallbackRequestId?: string
): LoggerScope {
  return (
    loggerScopeStorage.getStore() ?? {
      requestId: fallbackRequestId,
      requestLogger: fallbackRequestLogger,
    }
  )
}

export function runWithRequestLogger<T>(
  requestLogger: WideEventLogger,
  options: {
    requestId?: string
  },
  fn: () => T
): T {
  return loggerScopeStorage.run(
    {
      requestId: options.requestId,
      requestLogger,
    },
    fn
  )
}

function createFieldsWithRequestId(
  requestId: string | undefined,
  fields?: LogMetadata
): LogFields | undefined {
  const sanitizedFields = sanitizeLogFields(fields)

  if (!requestId) {
    return sanitizedFields ? normalizeHttpSummaryFields(sanitizedFields) : undefined
  }

  const nextFields = { ...(sanitizedFields ?? {}) } as LogFields
  const request =
    nextFields.request && typeof nextFields.request === "object"
      ? { ...(nextFields.request as Record<string, unknown>) }
      : {}

  if (request.id === undefined) {
    request.id = requestId
  }

  return normalizeHttpSummaryFields({
    ...nextFields,
    request,
    requestId,
  })
}

function sanitizeLogFields(fields?: LogMetadata): LogFields | undefined {
  if (!fields) {
    return undefined
  }

  const nextFields = { ...fields } as Record<string, unknown>

  if (typeof nextFields.service !== "string") {
    delete nextFields.service
  }

  delete nextFields.tag

  return nextFields as LogFields
}

function normalizeHttpSummaryFields(fields: LogFields): LogFields {
  const request =
    fields.request && typeof fields.request === "object"
      ? { ...(fields.request as Record<string, unknown>) }
      : undefined

  if (!request) {
    return fields
  }

  const nextFields = {
    ...fields,
    request,
  } as Record<string, unknown>
  const requestMethod = typeof request.method === "string" ? request.method : undefined
  const requestPath = typeof request.path === "string" ? request.path : undefined
  const requestRoute = typeof request.route === "string" ? request.route : undefined
  const requestStatus = typeof request.status === "number" ? request.status : undefined
  const requestDuration = typeof request.duration === "number" ? request.duration : undefined

  if (requestMethod && shouldPromoteRequestMethod(nextFields.method)) {
    nextFields.method = requestMethod
  }

  if (requestRoute) {
    // Prefer the logical route over the transport path in evlog's summary line.
    nextFields.path = requestRoute
    nextFields.route = requestRoute
  } else if (requestPath && shouldPromoteRequestPath(nextFields.path)) {
    nextFields.path = requestPath
  }

  if (requestStatus !== undefined) {
    nextFields.status = requestStatus
  }

  if (requestDuration !== undefined) {
    nextFields.duration = requestDuration
  }

  return nextFields as LogFields
}

function shouldPromoteRequestMethod(value: unknown): boolean {
  return typeof value !== "string" || value.length === 0 || value === "UNKNOWN"
}

function shouldPromoteRequestPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return true
  }

  return value === "/" || value.toLowerCase() === "unknown"
}

function emitStructuredLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: LogMetadata
) {
  const event = {
    ...(sanitizeLogFields(fields) ?? {}),
    message,
  }

  if (level === "debug") {
    evlog.debug(event)
  } else if (level === "info") {
    evlog.info(event)
  } else if (level === "warn") {
    evlog.warn(event)
  } else {
    evlog.error(event)
  }
}

function normalizeErrorPayload(
  input: unknown,
  fields?: LogMetadata
): {
  error: string | Error
  fields?: LogMetadata
} {
  if (input instanceof Error || typeof input === "string") {
    return {
      error: input,
      fields,
    }
  }

  if (input && typeof input === "object") {
    const candidate = input as {
      message?: unknown
    }

    return {
      error:
        typeof candidate.message === "string" && candidate.message.length > 0
          ? new Error(candidate.message)
          : new Error("Unknown error"),
      fields: {
        ...(fields ?? {}),
        error_payload: input,
      },
    }
  }

  return {
    error: new Error(String(input ?? "Unknown error")),
    fields,
  }
}

export function createAppLogger(
  requestLogger: WideEventLogger,
  options?: {
    flush?: () => Promise<void>
    requestId?: string
  }
): AppLogger {
  const fallbackRequestId = options?.requestId
  const fallbackRequestLogger = requestLogger

  return {
    set(fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      scope.requestLogger.set(
        createFieldsWithRequestId(scope.requestId, fields as LogContext) as FieldContext<LogFields>
      )
    },
    debug(message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      const enrichedFields = createFieldsWithRequestId(scope.requestId, fields)

      if (enrichedFields) {
        scope.requestLogger.set(enrichedFields as FieldContext<LogFields>)
      }

      emitStructuredLog("debug", message, enrichedFields)
    },
    info(message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      scope.requestLogger.info(
        message,
        createFieldsWithRequestId(scope.requestId, fields) as FieldContext<LogFields> | undefined
      )
    },
    warn(message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      scope.requestLogger.warn(
        message,
        createFieldsWithRequestId(scope.requestId, fields) as FieldContext<LogFields> | undefined
      )
    },
    error(message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      const normalized = normalizeErrorPayload(message, fields)
      scope.requestLogger.error(
        normalized.error,
        createFieldsWithRequestId(scope.requestId, normalized.fields) as
          | FieldContext<LogFields>
          | undefined
      )
    },
    emit(level, message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      emitStructuredLog(level, message, createFieldsWithRequestId(scope.requestId, fields))
    },
    fatal(message, fields) {
      const scope = resolveLoggerScope(fallbackRequestLogger, fallbackRequestId)
      emitStructuredLog("error", message, createFieldsWithRequestId(scope.requestId, fields))
    },
    flush() {
      return options?.flush?.() ?? Promise.resolve()
    },
  }
}

export function createStandaloneRequestLogger(
  options?: RequestLoggerOptions,
  adapterOptions?: {
    flush?: () => Promise<void>
  }
): {
  requestLogger: WideEventLogger
  logger: AppLogger
} {
  const requestLogger = createEvlogRequestLogger<LogFields>(options)

  return {
    requestLogger,
    logger: createAppLogger(requestLogger, {
      flush: adapterOptions?.flush,
      requestId: options?.requestId,
    }),
  }
}

export function emitWideEvent(
  requestLogger: WideEventLogger,
  overrides?: LogFields & {
    _forceKeep?: boolean
    status?: number
    duration?: number
  }
) {
  return requestLogger.emit(
    overrides as FieldContext<LogFields> & {
      _forceKeep?: boolean
    }
  )
}
