import { CustomerService } from "./customers/service"
import type { ServiceDeps } from "./deps"
import { PlanService } from "./plans/service"

/**
 * The fully-wired service graph returned by `createServiceContext`.
 *
 * Services that already exist in the old ServiceContext keep the same
 * property names so migration is incremental. New services (like `plans`)
 * are added here first and then gradually adopted by routes.
 *
 * Phase 2 will add: subscriptions, billing, entitlements — once those
 * services accept injected collaborators instead of creating their own.
 */
export interface ServiceContext {
  customers: CustomerService
  plans: PlanService
}

/**
 * Build the domain service graph from infrastructure deps.
 *
 * Every service gets the same shared deps — no service creates its own
 * child services. This is the single composition root for all domain
 * services. Both Hono and tRPC entrypoints should call this.
 *
 * The graph is intentionally flat today. As Phase 2 progresses,
 * services like SubscriptionService will receive `customers` and
 * `billing` as constructor params instead of creating them internally.
 */
export function createServiceContext(deps: ServiceDeps): ServiceContext {
  const customers = new CustomerService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
  })

  const plans = new PlanService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
  })

  return {
    customers,
    plans,
  }
}
