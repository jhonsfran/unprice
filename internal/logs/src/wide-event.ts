// ============================================
// Wide Event Type Definitions (pure TypeScript, no Zod)
// ============================================

export interface RequestFields {
  id?: string
  parent_id?: string
  rate_limited?: boolean
  timestamp?: string
  user_agent?: string
  referer?: string
  host?: string
  port?: number
  path?: string
  route?: string
  query?: string
  params?: Record<string, unknown>
  headers?: Record<string, unknown>
  protocol?: "http" | "https"
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
  status?: number
  duration?: number
}

export interface BusinessFields {
  user_id?: string
  customer_id?: string
  project_id?: string
  workspace_id?: string
  feature_slug?: string
  is_main?: boolean
  is_internal?: boolean
  unprice_customer_id?: string
  operation?: string
}

export interface ErrorFields {
  type?: string
  message?: string
  stack?: string
  trpc_code?: string
}

export interface GeoFields {
  colo?: string
  country?: string
  continent?: string
  city?: string
  region?: string
  ip?: string
  ua?: string
  source?: string
}

export interface CloudFields {
  platform?: string
  isolate_id?: string
  isolate_lifetime?: number
  durable_object_id?: string
  region?: string
  runtime?: string
  runtime_version?: string
}

export interface LockFields {
  type?: "metric" | "log"
  resource?: string
  action?: string
  acquired?: boolean
  ttl_ms?: number
  max_hold_ms?: number
}

export interface UsageLimiterFields {
  operation?: string
  input?: unknown
  result?: unknown
  next_alarm?: string
}

export interface EntitlementsFields {
  allowed?: boolean
  denied_reason?: string
  feature_type?: string
  feature_slug?: string
  limit?: number
  usage?: number
  remaining?: number
  cost?: number
  state_found?: boolean
  cache_hit?: boolean
  revalidation_required?: boolean
  key_exists?: boolean
  already_recorded?: boolean
}

export interface CustomerFields {
  operation?: string
  email?: string
  name?: string
  currency?: string
  plan_version_id?: string
  plan_slug?: string
  success_url?: string
  cancel_url?: string
  session_id?: string
  customer_id?: string
  subscription_id?: string
  subscription_phase_id?: string
}

// ============================================
// Combined Wide Event Input
// ============================================

export interface WideEventInput {
  request?: RequestFields
  business?: BusinessFields
  error?: ErrorFields
  geo?: GeoFields
  cloud?: CloudFields
  lock?: LockFields
  usagelimiter?: UsageLimiterFields
  entitlements?: EntitlementsFields
  customers?: CustomerFields
}

export type ServiceEnvironment = "production" | "staging" | "development" | "preview" | "test"
