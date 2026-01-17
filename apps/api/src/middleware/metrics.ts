import type { Metric } from "@unprice/metrics"
import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "../hono/env"

type DiscriminateMetric<T, M = Metric> = M extends { metric: T } ? M : never

export function metrics(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const { metrics, logger } = c.get("services")
    const stats = c.get("stats")
    const start = c.get("performanceStart")

    const m = {
      isolateId: c.get("isolateId"),
      isolateLifetime: Date.now() - c.get("isolateCreatedAt"),
      metric: "metric.http.request",
      path: c.req.path,
      host: new URL(c.req.url).host,
      method: c.req.method,
      continent: stats.continent,
      country: stats.country,
      colo: stats.colo,
      city: stats.city,
      userAgent: stats.ua,
      source: stats.source,
      status: c.res.status,
      duration: performance.now() - start,
      service: "api",
      platform: "cloudflare",
    } as DiscriminateMetric<"metric.http.request">

    try {
      await next()
    } catch (e) {
      m.error = JSON.stringify(e)
      logger.error("request", {
        method: c.req.method,
        path: c.req.path,
        error: JSON.stringify(e),
      })
      throw e
    } finally {
      m.status = c.res.status
      m.duration = performance.now() - start
      c.res.headers.append("Unprice-Latency", `service=${m.duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      // Sample metrics to reduce overhead (default 1.0 -> 100%)
      // TODO: inject METRICS_SAMPLE_RATE
      // const sample = Number(c.env.METRICS_SAMPLE_RATE ?? "1")
      const sample = 1 // change if needed
      if (Math.random() < sample) {
        metrics.emit(m)
      }

      // flush metrics and logger
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await Promise.all([
              metrics.flush().catch((err: Error) => {
                logger.error("Failed to flush metrics", { error: err.message })
              }),
              logger.flush().catch((err: Error) => {
                console.error("Failed to flush logger", err)
              }),
            ])
          } catch (error) {
            console.error("Error during background flush", error)
          }
        })()
      )
    }
  }
}
