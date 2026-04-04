import { BillingService } from "./billing/service"
import { CustomerService } from "./customers/service"
import type { ServiceDeps } from "./deps"
import { GrantsManager } from "./entitlements/grants"
import { PlanService } from "./plans/service"

/**
 * The fully-wired service graph returned by `createServiceContext`.
 *
 * Every service here is constructed once and collaborators are injected —
 * no service creates its own child services.
 */
export interface ServiceContext {
  customers: CustomerService
  grantsManager: GrantsManager
  billing: BillingService
  plans: PlanService
}

/**
 * Build the domain service graph from infrastructure deps.
 *
 * This is the single composition root for all domain services.
 * Construction order matters: leaf services first, then services
 * that depend on them.
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

  const grantsManager = new GrantsManager({
    db: deps.db,
    logger: deps.logger,
  })

  const billing = new BillingService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    grantsManager,
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
    grantsManager,
    billing,
    plans,
  }
}
