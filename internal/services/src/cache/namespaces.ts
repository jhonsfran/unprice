import type {
  FeatureHeatmap,
  FeaturesOverview,
  PageBrowserVisits,
  PageCountryVisits,
  PageOverview,
  PlansConversion,
  Stats,
  Usage,
  VerificationRegions,
  Verifications,
} from "@unprice/analytics"
import type {
  ApiKeyExtended,
  CurrentUsage,
  Customer,
  CustomerPaymentMethod,
  Entitlement,
  Feature,
  MinimalEntitlement,
  PlanVersionApi,
  Project,
  ReportUsageResult,
  SubscriptionCache,
  SubscriptionStatus,
  Workspace,
} from "@unprice/db/validators"

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

export type CacheNamespaces = {
  apiKeyByHash: ApiKeyExtended | null
  customerSubscription: SubscriptionCache | null
  customer: CustomerCache | null
  customerEntitlement: Entitlement | null
  accessControlList: {
    customerUsageLimitReached: boolean | null
    customerDisabled: boolean | null
    subscriptionStatus: SubscriptionStatus | null
  } | null
  customerEntitlements: MinimalEntitlement[]
  negativeEntitlements: boolean
  customerPaymentMethods: CustomerPaymentMethod[] | null
  projectFeatures: ProjectFeatureCache | null
  idempotentRequestUsageByHash: ReportUsageResult | null
  planVersionList: PlanVersionApi[] | null
  planVersion: PlanVersionApi | null
  pageCountryVisits: PageCountryVisits | null
  pageBrowserVisits: PageBrowserVisits | null
  getPagesOverview: PageOverview | null
  getFeatureHeatmap: FeatureHeatmap | null
  getFeaturesOverview: FeaturesOverview | null
  getPlansStats: Stats | null
  getPlansConversion: PlansConversion | null
  getOverviewStats: Stats | null
  getUsage: Usage | null
  getVerifications: Verifications | null
  getVerificationRegions: VerificationRegions | null
  getCurrentUsage: CurrentUsage | null
}

export type CacheNamespace = keyof CacheNamespaces
