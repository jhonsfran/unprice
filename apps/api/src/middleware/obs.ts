import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "../hono/env"
import { apiDrain } from "../observability"

export function obs(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const logger = c.get("logger")
    const start = c.get("performanceStart")
    const requestId = c.get("requestId")
    const isolateLifetime = Date.now() - c.get("isolateCreatedAt")

    try {
      await next()
    } finally {
      const status = c.res.status
      const duration = Date.now() - start

      c.res.headers.set("Unprice-Request-Id", requestId)
      c.res.headers.append("Unprice-Latency", `service=${duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      logger.set({
        request: { status, duration },
        cloud: { isolate_lifetime: isolateLifetime },
      })

      // Flush the pipeline buffer; waitUntil keeps the worker alive
      if (apiDrain) {
        c.executionCtx.waitUntil(apiDrain.flush())
      }
    }
  }
}
