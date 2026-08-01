import type {
  PageBrowserVisits,
  PageCountryVisits,
  PageOverview,
  Stats,
  Usage,
} from "@unprice/analytics"
import type { budgetRuns } from "@unprice/db/schema"
import type {
  ApiKeyExtended,
  ApiKeyType,
  Customer,
  CustomerPaymentMethod,
  Feature,
  PlanVersionApi,
  Project,
  SubscriptionCache,
  SubscriptionStatus,
  User,
  Workspace,
  WorkspaceRole,
} from "@unprice/db/validators"
import type { PreparedCustomerGrantContext } from "../ingestion/entitlement-context"
import type { GetUsageDashboardOutput } from "../use-cases/analytics/get-usage-dashboard"

export type ProjectFeatureCache = {
  project: {
    enabled: boolean
  }
  features: Feature[]
}

export type CustomerCache = Customer & {
  project: Project & {
    workspace: Workspace
  }
}

export type WorkspaceGuardCache = {
  workspace: Workspace
  member: User & { role: WorkspaceRole }
}

export type CustomersProjectCache = Pick<Customer, "id" | "name" | "email" | "projectId" | "isMain">

export type BudgetRunCache = typeof budgetRuns.$inferSelect

/**
 * What the api key cache actually holds, which is not what the table holds.
 *
 * `apikeys.type` is NOT NULL in the database, but cache entries are stored as plain JSON and
 * are never re-parsed on read, so entries serialized before the column shipped come back with
 * no `type` at all. `type` is optional here on purpose: it forces every reader to resolve the
 * missing value (`keyAuth` does, to `runtime`) instead of trusting a field the deploy window
 * cannot guarantee. Do not "simplify" this to `ApiKeyExtended` — the compiler would stop
 * catching the omission and every cached runtime key would start failing authorization until
 * its TTL expired.
 */
export type ApiKeyCache = Omit<ApiKeyExtended, "type"> & { type?: ApiKeyType }

export type CacheNamespaces = {
  apiKeyByHash: ApiKeyCache | null
  budgetRun: BudgetRunCache | null
  customersProject: CustomersProjectCache[] | null
  customerSubscription: SubscriptionCache | null
  customer: CustomerCache | null
  customerByExternalId: CustomerCache | null
  accessControlList: {
    customerUsageLimitReached: boolean | null
    customerDisabled: boolean | null
    subscriptionStatus: SubscriptionStatus | null
  } | null
  customerPaymentMethods: CustomerPaymentMethod[] | null
  projectFeatures: ProjectFeatureCache | null
  workspaceGuard: WorkspaceGuardCache | null
  planVersionList: PlanVersionApi[] | null
  planVersion: PlanVersionApi | null
  pageCountryVisits: PageCountryVisits | null
  pageBrowserVisits: PageBrowserVisits | null
  getPagesOverview: PageOverview | null
  getPlansStats: Stats | null
  getOverviewStats: Stats | null
  getUsage: Usage | null
  getUsageDashboard: GetUsageDashboardOutput | null
  ingestionPreparedGrantContext: PreparedCustomerGrantContext
}

export type CacheNamespace = keyof CacheNamespaces
