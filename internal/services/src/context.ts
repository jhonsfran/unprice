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
import { DrizzleLedgerRepository } from "./ledger/repository.drizzle"
import { LedgerService } from "./ledger/service"
import { PageService } from "./pages/service"
import { PaymentProviderResolver } from "./payment-provider/resolver"
import { PlanService } from "./plans/service"
import { ProjectService } from "./projects/service"
import { RatingService } from "./rating/service"
import { DrizzleSubscriptionRepository } from "./subscriptions/repository.drizzle"
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
  paymentProviderResolver: PaymentProviderResolver
  rating: RatingService
  ledger: LedgerService
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
 * that depend on them.
 */
export function createServiceContext(deps: ServiceDeps): ServiceContext {
  // 1. Leaf services (no service deps)
  const analytics = new AnalyticsService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
  })

  const paymentProviderResolver = new PaymentProviderResolver({
    db: deps.db,
    logger: deps.logger,
  })

  const ledger = new LedgerService({
    repo: new DrizzleLedgerRepository(deps.db),
    logger: deps.logger,
    metrics: deps.metrics,
  })

  const customers = new CustomerService({
    db: deps.db,
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    paymentProviderResolver,
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
  const rating = new RatingService({
    logger: deps.logger,
    analytics: deps.analytics,
    grantsManager,
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
    ratingService: rating,
    ledgerService: ledger,
  })

  const subscriptions = new SubscriptionService({
    db: deps.db,
    repo: new DrizzleSubscriptionRepository(deps.db),
    logger: deps.logger,
    analytics: deps.analytics,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    billingService: billing,
    ratingService: rating,
    ledgerService: ledger,
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
    paymentProviderResolver,
    rating,
    ledger,
    billing,
    subscriptions,
    entitlements,
    plans,
  }
}
