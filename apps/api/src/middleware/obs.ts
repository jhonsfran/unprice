import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "../hono/env"

export function obs(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const metrics = c.get("metrics")
    const logger = c.get("logger")
    const start = c.get("performanceStart")
    const requestId = c.get("requestId")
    const isolateLifetime = Date.now() - c.get("isolateCreatedAt")

    try {
      await next()
    } catch (e) {
      logger.set({
        cloud: {
          isolate_lifetime: isolateLifetime,
        },
      })
      throw e
    } finally {
      const status = c.res.status
      const duration = Date.now() - start
      c.res.headers.set("Unprice-Request-Id", requestId)
      c.res.headers.append("Unprice-Latency", `service=${duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      logger.set({
        request: {
          status,
          duration,
        },
        cloud: {
          isolate_lifetime: isolateLifetime,
        },
      })

      // Give the outer evlog middleware a tick to emit the request event before flushing the drain.
      const FLUSH_TIMEOUT_MS = 10_000
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))

            await Promise.race([
              Promise.all([
                metrics.flush().catch((err: Error) => {
                  logger.emit("error", "Failed to flush metrics", { error: err.message })
                }),
                logger.flush().catch((err: Error) => {
                  logger.emit("error", "Failed to flush logger", { error: err.message })
                }),
              ]),
              new Promise<void>((resolve) => setTimeout(() => resolve(), FLUSH_TIMEOUT_MS)),
            ])
          } catch (error) {
            logger.emit("error", "Error during background flush", {
              error: error instanceof Error ? error.message : String(error ?? "unknown"),
            })
          }
        })()
      )
    }
  }
}
