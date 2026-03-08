import { z } from "zod"

// ============================================
// NESTED SCHEMAS (Source of truth)
// ============================================

export const RequestSchema = z.object({
  id: z.string(),
  parent_id: z.string().optional(),
  rate_limited: z.boolean().optional(),
  timestamp: z.string().datetime(),
  user_agent: z.string().optional(),
  referer: z.string().optional(),
  host: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string(),
  route: z.string().optional(),
  query: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  headers: z.record(z.unknown()).optional(),
  protocol: z.enum(["http", "https"]),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  status: z.number().int().min(100).max(599),
  duration: z.number().nonnegative(),
})

export const BusinessSchema = z.object({
  user_id: z.string().optional(),
  customer_id: z.string().optional(),
  project_id: z.string().optional(),
  workspace_id: z.string().optional(),
  feature_slug: z.string().optional(),
  is_main: z.boolean().optional(),
  is_internal: z.boolean().optional(),
  unprice_customer_id: z.string().optional(),
  operation: z.string().optional(),
})

export const ErrorSchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  stack: z.string().optional(),
  trpc_code: z.string().optional(),
})

export const GeoSchema = z.object({
  colo: z.string().optional(),
  country: z.string().optional(),
  continent: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  ip: z.string().optional(),
  ua: z.string().optional(),
  source: z.string().optional(),
})

export const CloudSchema = z.object({
  platform: z.string(),
  isolate_id: z.string().optional(),
  isolate_lifetime: z.number().optional(),
  durable_object_id: z.string().optional(),
  region: z.string().optional(),
  runtime: z.string().optional(),
  runtime_version: z.string().optional(),
})

export const LogMetadataSchema = z.object({
  type: z.enum(["metric", "normal", "wide_event"]).optional(),
})

export const LockSchema = z.object({
  type: z.enum(["metric", "normal", "wide_event"]).optional(),
  resource: z.string().optional(),
  action: z.string().optional(),
  acquired: z.boolean().optional(),
  ttl_ms: z.number().optional(),
  max_hold_ms: z.number().optional(),
})

// ============================================
// COMBINED NESTED SCHEMA
// ============================================

export const UsageLimiterSchema = z.object({
  operation: z.string().optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  next_alarm: z.string().datetime().optional(),
})

export const EntitlementsSchema = z.object({
  allowed: z.boolean().optional(),
  denied_reason: z.string().optional(),
  feature_type: z.string().optional(),
  feature_slug: z.string().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  remaining: z.number().optional(),
  cost: z.number().optional(),
  state_found: z.boolean().optional(),
  cache_hit: z.boolean().optional(),
  revalidation_required: z.boolean().optional(),
  key_exists: z.boolean().optional(),
  already_recorded: z.boolean().optional(),
})

export const CustomerSchema = z.object({
  operation: z.string().optional(),
  email: z.string().email(),
  name: z.string().optional(),
  currency: z.string().optional(),
  plan_version_id: z.string().optional(),
  plan_slug: z.string().optional(),
  success_url: z.string().optional(),
  cancel_url: z.string().optional(),
  session_id: z.string().optional(),
  customer_id: z.string().optional(),
  subscription_id: z.string().optional(),
  subscription_phase_id: z.string().optional(),
})

export const WideEventNestedSchema = z.object({
  log: LogMetadataSchema.optional(),
  request: RequestSchema.partial(),
  business: BusinessSchema.optional(),
  error: ErrorSchema.optional(),
  geo: GeoSchema.optional(),
  cloud: CloudSchema.optional(),
  lock: LockSchema.optional(),
  usagelimiter: UsageLimiterSchema.optional(),
  entitlements: EntitlementsSchema.optional(),
  customers: CustomerSchema.optional(),
})

export type WideEventNested = z.infer<typeof WideEventNestedSchema>

// ============================================
// TYPE UTILITIES - Flatten nested to dot notation
// ============================================

type Primitive = string | number | boolean | null | undefined

// Flatten { a: { b: string } } → { "a.b": string }
type Flatten<T, Prefix extends string = ""> = T extends Primitive
  ? never
  : {
      [K in keyof T & string]: T[K] extends Primitive | undefined
        ? { [P in `${Prefix}${K}`]: T[K] }
        : T[K] extends Record<string, unknown> | undefined
          ? Flatten<NonNullable<T[K]>, `${Prefix}${K}.`>
          : { [P in `${Prefix}${K}`]: T[K] }
    }[keyof T & string]

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

type FlattenToObject<T> = UnionToIntersection<Flatten<T>>

// ============================================
// EXPORTED TYPES
// ============================================

// All known flattened attributes: "request.method", "business.project_id", etc.
export type WideEventAttributes = FlattenToObject<WideEventNested>

// Keys of known attributes
export type WideEventKey = keyof WideEventAttributes

// Input for addMany() - partial nested structure
export type WideEventInput = {
  [K in keyof WideEventNested]?: Partial<WideEventNested[K]>
}

export type LockType = NonNullable<z.infer<typeof LockSchema>["type"]>
export type ServiceEnvironment = "production" | "staging" | "development" | "preview" | "test"

// Final emitted event emitted by evlog.
export type WideEvent = Partial<WideEventAttributes> & {
  service: string
  environment: ServiceEnvironment
  version?: string
}
