import { AnalyticsService } from "./analytics/service"
import { ApiKeysService } from "./apikey/service"
import { BillingService } from "./billing/service"
import { CustomerService } from "./customers/service"
import type { ServiceDeps } from "./deps"
import { DomainService } from "./domains/service"
import { GrantsManager } from "./entitlements/grants"
import { EntitlementService } from "./entitlements/service"
import { EventService } from "./events/service"
import { FeatureService } from "./features/service"
import { PageService } from "./pages/service"
import { PlanService } from "./plans/service"
import { ProjectService } from "./projects/service"
import { SubscriptionService } from "./subscriptions/service"
import { WorkspaceService } from "./workspaces/service"

/**
 * The fully-wired service graph returned by `createServiceContext`.
 *
 * Every service here is constructed once and collaborators are injected —
 * no service creates its own child services.
 */
export interface ServiceContext {
  analytics: AnalyticsService
  apikeys: ApiKeysService
  customers: CustomerService
  domains: DomainService
  events: EventService
  features: FeatureService
  pages: PageService
  projects: ProjectService
  workspaces: WorkspaceService
  grantsManager: GrantsManager
  billing: BillingService
  subscriptions: SubscriptionService
  entitlements: EntitlementService
  plans: PlanService
}

/**
 * Build the domain service graph from infrastructure deps.
 *
 * This is the single composition root for all domain services.
 * Construction order matters: leaf services first, then services
 * that depend on them. The Customer ↔ Subscription cycle is resolved
 * via a post-construction setter.
 */
export function createServiceContext(deps: ServiceDeps): ServiceContext {
  // 1. Leaf services (no service deps)
  const analytics = new AnalyticsService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
  })

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

  const apikeys = new ApiKeysService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    hashCache: new Map<string, string>(),
  })

  const plans = new PlanService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
  })

  const features = new FeatureService({
    db: deps.db,
    logger: deps.logger,
  })

  const domains = new DomainService({
    db: deps.db,
    logger: deps.logger,
  })

  const events = new EventService({
    db: deps.db,
    logger: deps.logger,
  })

  const pages = new PageService({
    db: deps.db,
    logger: deps.logger,
  })

  const projects = new ProjectService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
  })

  const workspaces = new WorkspaceService({
    db: deps.db,
    logger: deps.logger,
  })

  // 2. Services with deps on leaves
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

  const subscriptions = new SubscriptionService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    billingService: billing,
  })

  const entitlements = new EntitlementService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    grantsManager,
    billingService: billing,
  })

  // 3. Resolve the Customer ↔ Subscription cycle
  customers.setSubscriptionService(subscriptions)

  return {
    analytics,
    apikeys,
    customers,
    domains,
    events,
    features,
    pages,
    projects,
    workspaces,
    grantsManager,
    billing,
    subscriptions,
    entitlements,
    plans,
  }
}
