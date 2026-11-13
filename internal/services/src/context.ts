import { type BasinSql, createBasinSql } from "@unprice/lakehouse"
import { env } from "../env"
import { BudgetJournalReader } from "./analytics/budget-journal-reader"
import { AnalyticsService } from "./analytics/service"
import { ApiKeysService } from "./apikey/service"
import { BillingService } from "./billing/service"
import { BudgetAuditService } from "./budget-audit/service"
import { BudgetCatalogService } from "./budget-catalog/service"
import { CustomerService } from "./customers/service"
import type { ServiceDeps } from "./deps"
import { DomainService } from "./domains/service"
import { GrantsManager } from "./entitlements/grants"
import { EntitlementService } from "./entitlements/service"
import { EventService } from "./events/service"
import { FeatureService } from "./features/service"
import { CustomerLedgerService, LedgerGateway } from "./ledger"
import { ModelCostService } from "./model-costs/service"
import { PageService } from "./pages/service"
import { PaymentProviderResolver } from "./payment-provider/resolver"
import { PlanService } from "./plans/service"
import { ProjectService } from "./projects/service"
import { RateCardService } from "./rate-cards/service"
import { DrizzleSubscriptionRepository } from "./subscriptions/repository.drizzle"
import { SubscriptionService } from "./subscriptions/service"
import { InternalApiClient } from "./use-cases/budgets/internal-api-client"
import {
  type BudgetOperatorGateway,
  HttpBudgetOperatorGateway,
} from "./use-cases/budgets/operator-gateway"
import {
  HttpPayerBudgetGateway,
  type PayerBudgetGateway,
} from "./use-cases/budgets/payer-budget-gateway"
import { WalletService } from "./wallet"
import { WorkspaceService } from "./workspaces/service"

/**
 * The fully-wired service graph returned by `createServiceContext`.
 *
 * Every service here is constructed once and collaborators are injected —
 * no service creates its own child services.
 */
export interface ServiceContext {
  budgetCatalog: BudgetCatalogService
  budgetAudit: BudgetAuditService
  /** The dashboard's operator calls on budgets, through the API's internal routes. */
  budgetOperator: BudgetOperatorGateway
  analytics: AnalyticsService
  budgetJournal: BudgetJournalReader
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
  modelCosts: ModelCostService
  rateCards: RateCardService
  ledger: LedgerGateway
  customerLedger: CustomerLedgerService
  billing: BillingService
  subscriptions: SubscriptionService
  entitlements: EntitlementService
  plans: PlanService
  wallet: WalletService
}

/**
 * Build the domain service graph from infrastructure deps.
 *
 * This is the single composition root for all domain services.
 * Construction order matters: leaf services first, then services
 * that depend on them.
 */
export function createServiceContext(
  deps: ServiceDeps & {
    /**
     * Payer budget sync and invoicing. Defaults to the API's internal routes.
     */
    payerBudgets?: PayerBudgetGateway
    /**
     * Basin SQL: web analytics and the budget journal's usage history. Roots that never read them
     * omit it and get NOT_CONFIGURED.
     */
    basinSql?: BasinSql
  }
): ServiceContext {
  // 1. Leaf services (no service deps)
  const budgetCatalog = new BudgetCatalogService({
    db: deps.db,
    logger: deps.logger,
  })

  const budgetAudit = new BudgetAuditService({
    db: deps.db,
    logger: deps.logger,
  })

  const ledger = new LedgerGateway({
    db: deps.db,
    logger: deps.logger,
  })

  const customerLedger = new CustomerLedgerService({
    db: deps.db,
    logger: deps.logger,
  })

  const analytics = new AnalyticsService({
    db: deps.db,
    logger: deps.logger,
    basinSql: deps.basinSql ?? createBasinSql({}),
    ledgerGateway: ledger,
  })
  const budgetJournal = new BudgetJournalReader({
    logger: deps.logger,
    basinSql: deps.basinSql ?? createBasinSql({}),
  })

  const paymentProviderResolver = new PaymentProviderResolver({
    db: deps.db,
    logger: deps.logger,
  })

  const customers = new CustomerService({
    db: deps.db,
    logger: deps.logger,
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
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    hashCache: new Map<string, string>(),
  })

  const modelCosts = new ModelCostService({ db: deps.db })
  const rateCards = new RateCardService({ db: deps.db, modelCosts })

  const plans = new PlanService({
    db: deps.db,
    logger: deps.logger,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    rateCards,
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
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
  })

  const workspaces = new WorkspaceService({
    db: deps.db,
    logger: deps.logger,
  })

  // 2. Services with deps on leaves
  const wallet = new WalletService({
    db: deps.db,
    logger: deps.logger,
    ledgerGateway: ledger,
  })

  const internalApi = new InternalApiClient({
    baseUrl: env.UNPRICE_API_URL,
    token: env.UNPRICE_API_KEY,
  })
  const payerBudgets = deps.payerBudgets ?? new HttpPayerBudgetGateway(internalApi)
  const invoicing = { payerBudgets, rateCards }

  const billing = new BillingService({
    db: deps.db,
    logger: deps.logger,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    grantsManager,
    ledgerService: ledger,
    walletService: wallet,
    invoicing,
  })

  const entitlements = new EntitlementService({
    db: deps.db,
    logger: deps.logger,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    grantsManager,
    billingService: billing,
  })

  const subscriptions = new SubscriptionService({
    db: deps.db,
    repo: new DrizzleSubscriptionRepository(deps.db),
    logger: deps.logger,
    waitUntil: deps.waitUntil,
    cache: deps.cache,
    metrics: deps.metrics,
    customerService: customers,
    entitlementService: entitlements,
    billingService: billing,
    ledgerService: ledger,
    walletService: wallet,
    invoicing,
  })

  const budgetOperator = new HttpBudgetOperatorGateway(internalApi)

  return {
    budgetCatalog,
    budgetAudit,
    budgetOperator,
    analytics,
    budgetJournal,
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
    modelCosts,
    rateCards,
    ledger,
    customerLedger,
    billing,
    subscriptions,
    entitlements,
    plans,
    wallet,
  }
}
