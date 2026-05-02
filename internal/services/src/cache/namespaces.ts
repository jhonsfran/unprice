import type {
  PageBrowserVisits,
  PageCountryVisits,
  PageOverview,
  Stats,
  Usage,
} from "@unprice/analytics"
import type {
  ApiKeyExtended,
  CurrentUsage,
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
import type { PreparedCustomerGrantContext } from "../ingestion/service"

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

export type CacheNamespaces = {
  apiKeyByHash: ApiKeyExtended | null
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
  getCurrentUsage: CurrentUsage | null
  ingestionPreparedGrantContext: PreparedCustomerGrantContext
}

export type CacheNamespace = keyof CacheNamespaces
