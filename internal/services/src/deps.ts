import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import type { Cache } from "./cache/service"
import type { Metrics } from "./metrics"

/**
 * The six infrastructure dependencies shared by every domain service.
 *
 * Created once per request by each composition root (Hono middleware,
 * tRPC context, queue consumer) and threaded into every service via
 * the factory in `context.ts`.
 *
 * This replaces the ad-hoc `{ db, logger, analytics, waitUntil, cache, metrics }`
 * object that was duplicated in every service constructor.
 */
export interface ServiceDeps {
  db: Database
  logger: Logger
  analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
  waitUntil: (promise: Promise<any>) => void
  cache: Cache
  metrics: Metrics
}
