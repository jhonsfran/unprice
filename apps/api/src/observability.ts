import { env } from "cloudflare:workers"
import {
  type AppLogger,
  createAppLogger,
  createDrain,
  createStandaloneRequestLogger,
  emitWideEvent,
  initObservability,
  runWithRequestLogger,
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

// DO-side counterpart to `createApiLogger`. Durable Objects don't run inside
// a Hono request, so there's no `c.get("log")` WideEventLogger to feed in —
// we build the request logger from scratch via `createStandaloneRequestLogger`
// and reuse the same drain as the Hono path.
export function createDoLogger(requestId: string): AppLogger {
  const { logger } = createStandaloneRequestLogger({ requestId }, { flush: apiDrain?.flush })
  return logger
}

// Wrap a DO RPC method (or alarm handler) in an evlog "request" envelope so
// `logger.set(...)` and `logger.info/warn/error(...)` calls inside the body
// land on a wide event that actually gets `emit()`ed and shipped through the
// Axiom drain. Without this, the AppLogger from `createDoLogger` buffers
// fields onto a request logger that nobody ever emits — Hono's middleware
// does this automatically per HTTP request, but DOs have no equivalent.
//
// Inside `fn`, the existing `this.logger` instance still works thanks to the
// AsyncLocalStorage scope set up here — calls to `this.logger.set(...)`
// resolve to *this* envelope's request logger, not the constructor-bound one.
export async function runDoOperation<T>(
  params: {
    requestId: string
    service: string
    operation: string
    baseFields?: Record<string, unknown>
    waitUntil?: (promise: Promise<unknown>) => void
  },
  fn: (logger: AppLogger) => Promise<T>
): Promise<T> {
  const { requestLogger, logger } = createStandaloneRequestLogger(
    { requestId: params.requestId },
    { flush: apiDrain?.flush }
  )

  logger.set({
    service: params.service,
    operation: params.operation,
    request: { id: params.requestId },
    ...(params.baseFields ?? {}),
  })

  const startedAt = Date.now()
  return runWithRequestLogger(requestLogger, { requestId: params.requestId }, async () => {
    let thrown: unknown
    try {
      return await fn(logger)
    } catch (err) {
      thrown = err
      logger.error(err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      emitWideEvent(requestLogger, {
        status: thrown ? 500 : 200,
        duration: Date.now() - startedAt,
        ...(thrown ? { _forceKeep: true } : {}),
      })
      // Drain pipeline batches by default; force a flush so logs land before
      // the DO is evicted. waitUntil keeps the flush alive past the RPC
      // return without blocking the caller.
      params.waitUntil?.(logger.flush().catch(() => undefined))
    }
  })
}
