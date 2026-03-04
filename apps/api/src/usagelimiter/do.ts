import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { type Database, createConnection } from "@unprice/db"
import type {
  CurrentUsage,
  EntitlementState,
  MinimalEntitlement,
  ReportUsageRequest,
  ReportUsageResult,
  SubscriptionStatus,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import {
  AxiomLogger,
  ConsoleLogger,
  type Logger,
  type WideEventLogger,
  createWideEventHelpers,
  createWideEventLogger,
} from "@unprice/logging"
import { shouldEmitLogsToBackend, shouldEmitMetrics } from "@unprice/logging/env"
import { CacheService } from "@unprice/services/cache"
import { CustomerService, type DenyReason } from "@unprice/services/customers"
import { EntitlementService } from "@unprice/services/entitlements"
import { LogdrainMetrics, type Metrics, NoopMetrics } from "@unprice/services/metrics"
import { type Connection, type ConnectionContext, Server } from "partyserver"
import type { Env } from "~/env"
import { LakehousePipelineService } from "~/lakehouse/pipeline"
import type { BufferMetricsResponse } from "./interface"
import { type FlushPressureStats, SqliteDOStorageProvider } from "./sqlite-do-provider"

// colo never change after the object is created
interface UsageLimiterConfig {
  colo: string
}

type UsageInputSummary = {
  customerId: string
  projectId: string
  featureSlug: string
  usage?: number
  timestamp: number
  sync?: boolean
  action?: string
  keyId?: string
  country?: string
  region?: string
  metadataKeyCount?: number
  metadataKeySample?: string
}

type UsageResultSummary = {
  allowed: boolean
  message?: string
  deniedReason?: string
  featureType?: string
  cacheHit?: boolean
  remaining?: number
  limit?: number
  usage?: number
  cost?: number
  latency?: number
  notifiedOverLimit?: boolean
  degraded?: boolean
  degradedReason?: string
}

const METADATA_KEY_SAMPLE_LIMIT = 10
const SUBSCRIPTION_SNAPSHOT_CACHE_TTL_MS = 5_000
const CONNECTION_TAG_TAIL = "tail"
const CONNECTION_TAG_ALERTS = "alerts"

type RealtimeSubscriptionSnapshot = {
  status: SubscriptionStatus | null
  planSlug: string | null
  billingInterval: string | null
  phaseStartAt: number | null
  phaseEndAt: number | null
  cycleStartAt: number | null
  cycleEndAt: number | null
  timezone: string | null
}

type RealtimeFeatureSnapshot = {
  featureSlug: string
  featureType: "flat" | "tiered" | "usage" | "package"
  usage: number | null
  limit: number | null
  limitType: "hard" | "soft" | "none"
  effectiveAt: number | null
  expiresAt: number | null
}

type RealtimeAlertType = "limit_reached" | "limit_recovered"

type RealtimeConnectionState = {
  joinedAt: number
  tailActive: boolean
  tailExpiredAt: number | null
}

type SnapshotRequestMessage = {
  type: "snapshot_request"
  windowSeconds?: unknown
}

type VerifyRequestMessage = {
  type: "verify_request"
  requestId?: unknown
  featureSlug?: unknown
  usage?: unknown
  action?: unknown
  metadata?: unknown
}

type ResumeTailMessage = {
  type: "resume_tail"
}

type RealtimeClientMessage = SnapshotRequestMessage | VerifyRequestMessage | ResumeTailMessage

const summarizeUsageInput = (data: VerifyRequest | ReportUsageRequest): UsageInputSummary => {
  const metadataKeys = data.metadata ? Object.keys(data.metadata) : []
  const metadataKeySample = metadataKeys.slice(0, METADATA_KEY_SAMPLE_LIMIT).join(",")

  return {
    customerId: data.customerId,
    projectId: data.projectId,
    featureSlug: data.featureSlug,
    usage: data.usage,
    timestamp: data.timestamp,
    sync: "sync" in data ? data.sync : undefined,
    action: data.action,
    keyId: data.keyId,
    country: data.country,
    region: data.region,
    metadataKeyCount: metadataKeys.length || undefined,
    metadataKeySample: metadataKeySample || undefined,
  }
}

const summarizeUsageResult = (
  result: VerificationResult | ReportUsageResult
): UsageResultSummary => {
  return {
    allowed: result.allowed,
    message: result.message,
    deniedReason: result.deniedReason,
    featureType: "featureType" in result ? result.featureType : undefined,
    cacheHit: result.cacheHit,
    remaining: result.remaining,
    limit: result.limit,
    usage: result.usage,
    cost: result.cost,
    latency: "latency" in result ? result.latency : undefined,
    notifiedOverLimit: "notifiedOverLimit" in result ? result.notifiedOverLimit : undefined,
    degraded: result.degraded,
    degradedReason: result.degradedReason,
  }
}

const buildUsageByFeature = (states: EntitlementState[]): Record<string, number> => {
  const usageByFeature: Record<string, number> = {}

  for (const state of states) {
    usageByFeature[state.featureSlug] = Number(state.meter.usage ?? 0)
  }

  return usageByFeature
}

const buildRealtimeFeatures = (states: EntitlementState[]): RealtimeFeatureSnapshot[] => {
  const normalizeFeatureType = (
    featureType: EntitlementState["featureType"]
  ): RealtimeFeatureSnapshot["featureType"] => {
    return featureType === "tier" ? "tiered" : featureType
  }

  return states.map((state) => {
    const usage = Number(state.meter.usage ?? 0)
    const limit = typeof state.limit === "number" ? state.limit : null

    return {
      featureSlug: state.featureSlug,
      featureType: normalizeFeatureType(state.featureType),
      usage: Number.isFinite(usage) ? usage : null,
      limit,
      limitType: limit === null ? "none" : "hard",
      effectiveAt: state.effectiveAt ?? null,
      expiresAt: state.expiresAt ?? null,
    }
  })
}

const METADATA_MAX_KEYS = 50
const METADATA_MAX_SIZE_BYTES = 5_000

function normalizeWsAction(action: unknown): string | undefined {
  if (typeof action !== "string") return undefined
  const normalized = action.trim().toLowerCase().replace(/\s+/g, "-")
  return normalized.length > 0 ? normalized : undefined
}

function normalizeWsMetadata(metadata: unknown): Record<string, string | number | boolean> | null {
  if (metadata == null) {
    return null
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Invalid metadata payload")
  }

  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined)
  if (entries.length > METADATA_MAX_KEYS) {
    throw new Error(`Metadata exceeds ${METADATA_MAX_KEYS} properties`)
  }

  const normalized: Record<string, string | number | boolean> = {}

  for (const [key, value] of entries) {
    if (typeof value === "string" || typeof value === "boolean") {
      normalized[key] = value
      continue
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("Metadata number values must be finite")
      }
      normalized[key] = value
      continue
    }

    throw new Error("Metadata values must be string, number, or boolean")
  }

  if (JSON.stringify(normalized).length > METADATA_MAX_SIZE_BYTES) {
    throw new Error(`Metadata payload too large (max ${METADATA_MAX_SIZE_BYTES} bytes)`)
  }

  return normalized
}

function parseRealtimeClientMessage(message: string):
  | {
      ok: true
      value: RealtimeClientMessage
    }
  | {
      ok: false
      error: string
    } {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return {
      ok: false,
      error: "Invalid JSON message",
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Invalid message payload",
    }
  }

  const record = parsed as Record<string, unknown>
  const type = record.type

  if (type === "snapshot_request") {
    return {
      ok: true,
      value: {
        type: "snapshot_request",
        windowSeconds: record.windowSeconds,
      },
    }
  }

  if (type === "verify_request") {
    return {
      ok: true,
      value: {
        type: "verify_request",
        requestId: record.requestId,
        featureSlug: record.featureSlug,
        usage: record.usage,
        action: record.action,
        metadata: record.metadata,
      },
    }
  }

  if (type === "resume_tail") {
    return {
      ok: true,
      value: {
        type: "resume_tail",
      },
    }
  }

  return {
    ok: false,
    error: "Unsupported message type",
  }
}

// This durable object takes care of handling the usage of every feature per customer.
// It is used to validate the usage of a feature and to report the usage to tinybird.
// think of it as a queue that will be flushed to the db periodically
export class DurableObjectUsagelimiter extends Server {
  // environment variables
  private readonly _env: Env
  // logger service
  private logger: Logger
  // entitlement service
  private entitlementService: EntitlementService
  // customer service
  private customerService: CustomerService
  // database connection
  private readonly db: Database
  // storage provider
  private storage: SqliteDOStorageProvider
  // metrics service
  private metrics: Metrics
  // last broadcast message time
  private LAST_BROADCAST_MSG = Date.now()
  // debounce delay for the broadcast events
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second (1 per second)
  // max lifetime for a debug WebSocket session (5 minutes)
  private readonly MAX_DEBUG_SESSION_MS = 5 * 60 * 1000
  // sample rate for the wide event
  private SAMPLE_RATE = 0.1
  private readonly FLUSH_SEC_MIN = 5
  private readonly FLUSH_SEC_MAX = 30 * 60
  private readonly HEARTBEAT_FLUSH_SEC = 60
  private readonly ADAPTIVE_PROFILE_ALPHA = 0.2
  private readonly SLO_PENDING_WARN = 5000
  private readonly SLO_PENDING_ERROR = 20000
  private readonly SLO_OLDEST_AGE_WARN_SEC = 120
  private readonly SLO_OLDEST_AGE_ERROR_SEC = 600
  private adaptiveProfile = {
    emaPendingTotal: 0,
    emaOldestAgeSeconds: 0,
    samples: 0,
  }
  private readonly featureLimitReachedBySlug = new Map<string, boolean>()
  private subscriptionSnapshotCache: {
    value: RealtimeSubscriptionSnapshot | null
    fetchedAt: number
  } | null = null
  private entitlementsSnapshotCache: {
    value: MinimalEntitlement[] | null
    fetchedAt: number
  } | null = null

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    this._env = env

    if (env.APP_ENV === "development") {
      this.SAMPLE_RATE = 1
    }

    if (env.APP_ENV === "preview") {
      this.SAMPLE_RATE = 0.1
    }

    const emitLogsToBackend = shouldEmitLogsToBackend(env)
    const emitMetrics = shouldEmitMetrics(env)

    this.logger = emitLogsToBackend
      ? new AxiomLogger({
          apiKey: env.AXIOM_API_TOKEN,
          dataset: env.AXIOM_DATASET,
          requestId: this.ctx.id.toString(),
          logLevel: env.APP_ENV === "production" ? "warn" : "info",
          environment: env.NODE_ENV,
          service: "usagelimiter",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
            version: this._env.VERSION,
          },
        })
      : new ConsoleLogger({
          requestId: this.ctx.id.toString(),
          service: "usagelimiter",
          environment: env.NODE_ENV,
          logLevel: env.APP_ENV === "production" ? "warn" : "info",
          defaultFields: {
            durableObjectId: this.ctx.id.toString(),
            version: this._env.VERSION,
          },
        })

    this.metrics = emitMetrics
      ? new LogdrainMetrics({
          requestId: this.ctx.id.toString(),
          environment: env.NODE_ENV,
          logger: this.logger,
          service: "usagelimiter",
          durableObjectId: this.ctx.id.toString(),
          sampleRate: 1,
        })
      : new NoopMetrics()

    const cacheService = new CacheService(
      {
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        waitUntil: (promise: Promise<any>) => this.ctx.waitUntil(promise),
      },
      this.metrics,
      emitMetrics
    )

    const cloudflareCacheStore =
      env.CLOUDFLARE_ZONE_ID &&
      env.CLOUDFLARE_API_TOKEN &&
      env.CLOUDFLARE_CACHE_DOMAIN &&
      env.CLOUDFLARE_ZONE_ID !== "" &&
      env.CLOUDFLARE_API_TOKEN !== "" &&
      env.CLOUDFLARE_CACHE_DOMAIN !== ""
        ? new CloudflareStore({
            cloudflareApiKey: env.CLOUDFLARE_API_TOKEN,
            zoneId: env.CLOUDFLARE_ZONE_ID,
            domain: env.CLOUDFLARE_CACHE_DOMAIN,
            cacheBuster: "v2",
          })
        : undefined

    const stores = []

    // push the cloudflare store first to hit it first
    if (cloudflareCacheStore) {
      stores.push(cloudflareCacheStore)
    }

    // register the cloudflare store if it is configured
    cacheService.init(stores)

    const cache = cacheService.getCache()

    this.db = createConnection({
      env: env.NODE_ENV,
      primaryDatabaseUrl: env.DATABASE_URL,
      read1DatabaseUrl: env.DATABASE_READ1_URL,
      read2DatabaseUrl: env.DATABASE_READ2_URL,
      logger: env.DRIZZLE_LOG.toString() === "true",
      singleton: false, // Don't use singleton for hibernating DOs
    })

    const lakehousePipelineService = new LakehousePipelineService({
      logger: this.logger,
      pipelines: {
        usage: env.PIPELINE_USAGE,
        verification: env.PIPELINE_VERIFICATIONS,
        metadata: env.PIPELINE_METADATA,
        entitlement_snapshot: env.PIPELINE_ENTITLEMENTS,
      },
    })

    // initialize the storage provider
    this.storage = new SqliteDOStorageProvider({
      storage: this.ctx.storage,
      state: this.ctx,
      logger: this.logger,
      analytics: new Analytics({
        emit: true,
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      lakehouseService: lakehousePipelineService,
    })

    // initialize the storage provider - must block until complete
    // If initialization fails (e.g., schema version changed), reset storage and retry
    this.ctx.blockConcurrencyWhile(async () => {
      const result = await this.storage.initialize()
      if (result.err) {
        this.logger.warn("Storage initialization failed, resetting storage", {
          error: result.err.message,
        })
        // reset the storage and retry initialization - this is a last resort
        await this.ctx.storage.deleteAll()
        const retryResult = await this.storage.initialize()
        if (retryResult.err) {
          this.logger.error("Storage initialization failed after reset", {
            error: retryResult.err.message,
          })
        }
      }
    })

    // initialize the entitlement service
    this.entitlementService = new EntitlementService({
      db: this.db,
      storage: this.storage,
      logger: this.logger,
      analytics: new Analytics({
        emit: true,
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      cache: cache,
      metrics: this.metrics,
      config: {
        revalidateInterval:
          env.APP_ENV === "development"
            ? 30000 // 30 seconds
            : 1000 * 60 * 60 * 24, // 24 hours
      },
    })

    this.customerService = new CustomerService({
      db: this.db,
      logger: this.logger,
      analytics: new Analytics({
        emit: true,
        tinybirdToken: env.TINYBIRD_TOKEN,
        tinybirdUrl: env.TINYBIRD_URL,
        logger: this.logger,
      }),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      cache: cache,
      metrics: this.metrics,
    })

    // set the colo of the do
    this.setColo()
  }

  // set colo for metrics and analytics
  async setColo() {
    const config = await this.getConfig()

    if (config.colo === "" || config.colo === undefined) {
      let colo = "UNK"

      try {
        colo =
          (
            (await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text()).match(
              /^colo=(.+)/m
            ) as string[]
          )[1] ?? "UNK"
      } catch (e) {
        this.logger.error("error setting colo", {
          error: e instanceof Error ? e.message : "unknown error",
        })
      }

      config.colo = colo

      await this.updateConfig(config)
    }

    // block concurrency while setting the colo
    await this.ctx.blockConcurrencyWhile(async () => {
      this.metrics.setColo(config.colo)
    })
  }

  private async getConfig(): Promise<UsageLimiterConfig> {
    const raw = (await this.ctx.storage.get("config")) as UsageLimiterConfig | undefined
    return {
      colo: raw?.colo ?? "",
    }
  }

  private async updateConfig(config: UsageLimiterConfig) {
    await this.ctx.storage.put("config", {
      ...config,
    })
  }

  public async getCurrentUsage(data: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<CurrentUsage, BaseError>> {
    return await this.entitlementService.getCurrentUsage({
      ...data,
    })
  }

  public async resetEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return await this.entitlementService.resetEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }

  public async resetUsage(params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return await this.entitlementService.resetUsage({
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }

  public async getActiveEntitlements(params: {
    customerId: string
    projectId: string
  }): Promise<Result<MinimalEntitlement[], BaseError>> {
    return await this.entitlementService.getActiveEntitlements({
      customerId: params.customerId,
      projectId: params.projectId,
    })
  }

  public async getBufferMetrics(data?: {
    windowSeconds?: 300 | 3600 | 86400 | 604800
  }): Promise<Result<BufferMetricsResponse, BaseError>> {
    return await this.storage.getBufferStats(data?.windowSeconds)
  }

  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const url = new URL(context.request.url)
    const wantsTail = url.searchParams.get("tail") !== "0"
    const wantsAlerts = url.searchParams.get("alerts") !== "0"

    const tags: string[] = []
    if (wantsTail) {
      tags.push(CONNECTION_TAG_TAIL)
    }
    if (wantsAlerts) {
      tags.push(CONNECTION_TAG_ALERTS)
    }

    // Keep at least one channel enabled so important alerts are still delivered.
    if (tags.length === 0) {
      tags.push(CONNECTION_TAG_ALERTS)
    }

    return tags
  }

  private sendConnectionPayload(connection: Connection, payload: string): void {
    try {
      connection.send(payload)
    } catch (err) {
      this.logger.warn("Failed to send live event to connection", {
        connectionId: connection.id,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        connection.close(1011, "Send failed")
      } catch {
        // ignore
      }
    }
  }

  private expireTailConnection(connection: Connection<RealtimeConnectionState>, at: number): void {
    const currentState = connection.state
    const nextState: RealtimeConnectionState = {
      joinedAt: currentState?.joinedAt ?? at,
      tailActive: false,
      tailExpiredAt: at,
    }
    connection.setState(nextState)

    this.sendConnectionPayload(
      connection,
      JSON.stringify({
        type: "tail_expired",
        timestamp: at,
        message: "Live tail paused to reduce costs. Alerts remain active.",
      })
    )
  }

  // when connected through websocket we can broadcast events to the client
  // realtime events are used to debug events in dashboard
  async broadcastEvents(data: {
    customerId: string
    featureSlug: string
    deniedReason?: DenyReason
    usage?: number
    limit?: number
    notifyUsage?: boolean
    type: "verify" | "reportUsage"
    success: boolean
  }) {
    const connections = Array.from(
      this.getConnections<RealtimeConnectionState>(CONNECTION_TAG_TAIL)
    )

    // return early if there are no connections
    if (connections.length === 0) return

    const now = Date.now()

    // Only broadcast if enough time has passed since last broadcast
    // default 1 per second — used to debug events in real time in dashboard
    if (now - this.LAST_BROADCAST_MSG < this.DEBOUNCE_DELAY) {
      return
    }

    // build payload once
    const payload = JSON.stringify({
      ...data,
      kind: "tail",
      timestamp: now,
    })

    for (const conn of connections) {
      const joinedAt = conn.state?.joinedAt ?? now
      const tailActive = conn.state?.tailActive ?? true

      if (!tailActive) {
        continue
      }

      // time-box debug sessions to avoid forgotten tabs running forever
      if (now - joinedAt > this.MAX_DEBUG_SESSION_MS) {
        this.expireTailConnection(conn, now)
        continue
      }

      this.sendConnectionPayload(conn, payload)
    }

    this.LAST_BROADCAST_MSG = now
  }

  private buildLimitAlert(data: {
    featureSlug: string
    usage?: number
    limit?: number
  }): {
    alertType: RealtimeAlertType
    featureSlug: string
    usage: number
    limit: number
  } | null {
    if (
      typeof data.usage !== "number" ||
      !Number.isFinite(data.usage) ||
      typeof data.limit !== "number" ||
      !Number.isFinite(data.limit) ||
      data.limit <= 0
    ) {
      this.featureLimitReachedBySlug.delete(data.featureSlug)
      return null
    }

    const reachedLimit = data.usage >= data.limit
    const previous = this.featureLimitReachedBySlug.get(data.featureSlug)
    if (previous === reachedLimit) {
      return null
    }

    this.featureLimitReachedBySlug.set(data.featureSlug, reachedLimit)

    // Avoid a recovery event when we have no previous state.
    if (!reachedLimit && previous === undefined) {
      return null
    }

    return {
      alertType: reachedLimit ? "limit_reached" : "limit_recovered",
      featureSlug: data.featureSlug,
      usage: data.usage,
      limit: data.limit,
    }
  }

  private async broadcastAlertEvent(data: {
    customerId: string
    featureSlug: string
    alertType: RealtimeAlertType
    usage: number
    limit: number
    source: "verify" | "reportUsage"
  }): Promise<void> {
    const connections = Array.from(this.getConnections(CONNECTION_TAG_ALERTS))
    if (connections.length === 0) {
      return
    }

    const payload = JSON.stringify({
      type: "alert",
      kind: "alert",
      customerId: data.customerId,
      featureSlug: data.featureSlug,
      alertType: data.alertType,
      usage: data.usage,
      limit: data.limit,
      source: data.source,
      timestamp: Date.now(),
    })

    for (const connection of connections) {
      this.sendConnectionPayload(connection, payload)
    }
  }

  public async verify(data: VerifyRequest): Promise<VerificationResult> {
    const wideEventLogger = createWideEventLogger({
      "service.name": "usagelimiter",
      "service.version": this._env.VERSION,
      "service.environment": this._env.NODE_ENV as
        | "production"
        | "staging"
        | "development"
        | "preview"
        | "test",
      sampleRate: this.SAMPLE_RATE,
      emitter: (level, message, event) => this.logger.emit(level, message, event),
    })

    const wideEventHelpers = createWideEventHelpers(wideEventLogger)

    return await wideEventLogger.runAsync(async () => {
      try {
        // set the wide event helpers
        this.entitlementService.setWideEventHelpers(wideEventHelpers)

        // set the request id for the metrics and logs
        this.logger.x(data.requestId)
        this.metrics.x(data.requestId)
        wideEventLogger.add("request.id", data.requestId) // We don't need to generate a new id for the DO request
        wideEventLogger.add("request.timestamp", new Date().toISOString())
        wideEventHelpers.addParentRequestId(data.requestId) // Link to parent
        wideEventHelpers.addCloud({
          platform: "cloudflare",
          durable_object_id: this.ctx.id.toString(),
          region: this.metrics.getColo(),
        })
        wideEventLogger.add("usagelimiter.operation", "verify")
        wideEventLogger.add("usagelimiter.input", summarizeUsageInput(data))
        // All logic handled internally!
        const result = await this.entitlementService.verify(data)
        wideEventLogger.add("usagelimiter.result", summarizeUsageResult(result))
        // Set alarm to flush buffers
        await this.ensureAlarmIsSet(wideEventLogger)

        this.ctx.waitUntil(
          this.broadcastEvents({
            customerId: data.customerId,
            featureSlug: data.featureSlug,
            type: "verify",
            success: result.allowed,
            deniedReason: result.deniedReason as DenyReason | undefined,
            usage: result.usage,
            limit: result.limit,
          })
        )

        const limitAlert = this.buildLimitAlert({
          featureSlug: data.featureSlug,
          usage: result.usage,
          limit: result.limit,
        })
        if (limitAlert) {
          this.ctx.waitUntil(
            this.broadcastAlertEvent({
              customerId: data.customerId,
              featureSlug: limitAlert.featureSlug,
              alertType: limitAlert.alertType,
              usage: limitAlert.usage,
              limit: limitAlert.limit,
              source: "verify",
            })
          )
        }

        return result
      } catch (error) {
        const err = error as Error
        wideEventLogger.addError(err)
        return {
          allowed: false,
          message: err.message,
          deniedReason: "ENTITLEMENT_ERROR",
        }
      } finally {
        wideEventLogger.add("request.duration", Math.max(0, Date.now() - data.performanceStart))
        this.ctx.waitUntil(
          (async () => {
            try {
              await Promise.all([
                // only log if the event should be sampled
                wideEventLogger.emit(),
                this.metrics.flush().catch((err: Error) => {
                  console.error("Failed to flush metrics in DO", err)
                }),
                this.logger.flush().catch((err: Error) => {
                  console.error("Failed to flush logger in DO", err)
                }),
              ])
            } catch (error) {
              console.error("Error during background flush in DO", error)
            }
          })()
        )
      }
    })
  }

  public async reportUsage(data: ReportUsageRequest): Promise<ReportUsageResult> {
    const wideEventLogger = createWideEventLogger({
      "service.name": "usagelimiter",
      "service.version": this._env.VERSION,
      "service.environment": this._env.NODE_ENV as
        | "production"
        | "staging"
        | "development"
        | "preview"
        | "test",
      sampleRate: this.SAMPLE_RATE,
      emitter: (level, message, event) => this.logger.emit(level, message, event),
    })

    const wideEventHelpers = createWideEventHelpers(wideEventLogger)

    return await wideEventLogger.runAsync(async () => {
      try {
        // set the wide event helpers
        this.entitlementService.setWideEventHelpers(wideEventHelpers)

        // set the request id for the metrics and logs
        this.logger.x(data.requestId)
        this.metrics.x(data.requestId)

        wideEventLogger.add("request.id", data.requestId)
        wideEventLogger.add("request.timestamp", new Date().toISOString())
        wideEventHelpers.addParentRequestId(data.requestId)
        wideEventHelpers.addCloud({
          platform: "cloudflare",
          durable_object_id: this.ctx.id.toString(),
          region: this.metrics.getColo(),
        })
        wideEventLogger.add("usagelimiter.operation", "reportUsage")
        wideEventLogger.add("usagelimiter.input", summarizeUsageInput(data))

        const result = await this.entitlementService.reportUsage(data)
        wideEventLogger.add("usagelimiter.result", summarizeUsageResult(result))
        // Set alarm to flush buffers
        await this.ensureAlarmIsSet(wideEventLogger)

        this.ctx.waitUntil(
          this.broadcastEvents({
            customerId: data.customerId,
            featureSlug: data.featureSlug,
            type: "reportUsage",
            success: result.allowed,
            deniedReason: result.deniedReason as DenyReason | undefined,
            usage: result.usage,
            limit: result.limit,
          })
        )

        const limitAlert = this.buildLimitAlert({
          featureSlug: data.featureSlug,
          usage: result.usage,
          limit: result.limit,
        })
        if (limitAlert) {
          this.ctx.waitUntil(
            this.broadcastAlertEvent({
              customerId: data.customerId,
              featureSlug: limitAlert.featureSlug,
              alertType: limitAlert.alertType,
              usage: limitAlert.usage,
              limit: limitAlert.limit,
              source: "reportUsage",
            })
          )
        }

        return result
      } catch (error) {
        const err = error as Error
        wideEventLogger.addError(err)

        return {
          message: error instanceof Error ? error.message : "unknown error",
          allowed: false,
        }
      } finally {
        data.performanceStart &&
          wideEventLogger.add("request.duration", Math.max(0, Date.now() - data.performanceStart))

        this.ctx.waitUntil(
          (async () => {
            try {
              await Promise.all([
                // only log if the event should be sampled
                wideEventLogger.emit(),
                this.metrics.flush().catch((err: Error) => {
                  console.error("Failed to flush metrics in DO", err)
                }),
                this.logger.flush().catch((err: Error) => {
                  console.error("Failed to flush logger in DO", err)
                }),
              ])
            } catch (error) {
              console.error("Error during background flush in DO", error)
            }
          })()
        )
      }
    })
  }

  // ensure the alarm is set to flush the usage records and verifications
  private async ensureAlarmIsSet(wideEventLogger: WideEventLogger): Promise<void> {
    const now = Date.now()
    const currentAlarm = await this.ctx.storage.getAlarm()
    const heartbeatWindowMs = this.getHeartbeatFlushSeconds() * 1000

    // Keep healthy alarms untouched so request paths stay lightweight.
    if (currentAlarm !== null && currentAlarm >= now && currentAlarm <= now + heartbeatWindowMs) {
      wideEventLogger.add("usagelimiter.next_alarm", new Date(currentAlarm).toISOString())
      return
    }

    // The request path only repairs heartbeat scheduling; pressure-based fast retries happen in onAlarm().
    const nextAlarm = await this.scheduleAlarmWithHeartbeat(this.getHeartbeatFlushSeconds())
    wideEventLogger.add("usagelimiter.next_alarm", new Date(nextAlarm).toISOString())
  }

  private getHeartbeatFlushSeconds(): number {
    return Math.min(Math.max(this.HEARTBEAT_FLUSH_SEC, this.FLUSH_SEC_MIN), this.FLUSH_SEC_MAX)
  }

  private async scheduleAlarmWithHeartbeat(targetFlushSec: number): Promise<number> {
    const now = Date.now()
    const heartbeatFlushSec = this.getHeartbeatFlushSeconds()
    const boundedTargetSec = Math.min(
      Math.max(targetFlushSec, this.FLUSH_SEC_MIN),
      heartbeatFlushSec
    )
    const targetAlarm = now + boundedTargetSec * 1000
    const currentAlarm = await this.ctx.storage.getAlarm()

    const shouldUpdateAlarm =
      currentAlarm === null || currentAlarm < now || currentAlarm > targetAlarm

    if (shouldUpdateAlarm) {
      await this.ctx.storage.setAlarm(targetAlarm)
      return targetAlarm
    }

    return currentAlarm
  }

  private getAdaptiveFlushSeconds(
    pressure: FlushPressureStats | null,
    fallbackFlushSec: number
  ): number {
    if (!pressure) {
      return fallbackFlushSec
    }

    this.updateAdaptiveProfile(pressure)

    const effectivePending = Math.max(
      pressure.pendingTotalRecords,
      Math.round(this.adaptiveProfile.emaPendingTotal)
    )
    const effectiveOldestAgeSeconds = Math.max(
      pressure.oldestPendingAgeSeconds,
      Math.round(this.adaptiveProfile.emaOldestAgeSeconds)
    )

    let adaptive = fallbackFlushSec

    if (effectivePending >= 20000) {
      adaptive = Math.min(adaptive, 5)
    } else if (effectivePending >= 10000) {
      adaptive = Math.min(adaptive, 10)
    } else if (effectivePending >= 5000) {
      adaptive = Math.min(adaptive, 15)
    } else if (effectivePending >= 2000) {
      adaptive = Math.min(adaptive, 30)
    } else if (effectivePending >= 500) {
      adaptive = Math.min(adaptive, 45)
    }

    if (effectiveOldestAgeSeconds >= 5 * 60) {
      adaptive = Math.min(adaptive, 10)
    }

    return Math.min(Math.max(adaptive, this.FLUSH_SEC_MIN), this.FLUSH_SEC_MAX)
  }

  private updateAdaptiveProfile(pressure: FlushPressureStats): void {
    if (this.adaptiveProfile.samples === 0) {
      this.adaptiveProfile.emaPendingTotal = pressure.pendingTotalRecords
      this.adaptiveProfile.emaOldestAgeSeconds = pressure.oldestPendingAgeSeconds
      this.adaptiveProfile.samples = 1
      return
    }

    const alpha = this.ADAPTIVE_PROFILE_ALPHA
    this.adaptiveProfile.emaPendingTotal =
      alpha * pressure.pendingTotalRecords + (1 - alpha) * this.adaptiveProfile.emaPendingTotal
    this.adaptiveProfile.emaOldestAgeSeconds =
      alpha * pressure.oldestPendingAgeSeconds +
      (1 - alpha) * this.adaptiveProfile.emaOldestAgeSeconds
    this.adaptiveProfile.samples += 1
  }

  private emitFlushPressureSlo(phase: "schedule" | "alarm", pressure: FlushPressureStats): void {
    const fields = {
      phase,
      pendingTotalRecords: pressure.pendingTotalRecords,
      pendingUsageRecords: pressure.pendingUsageRecords,
      pendingVerificationRecords: pressure.pendingVerificationRecords,
      oldestPendingAgeSeconds: pressure.oldestPendingAgeSeconds,
      oldestPendingTimestamp: pressure.oldestPendingTimestamp,
      emaPendingTotal: Math.round(this.adaptiveProfile.emaPendingTotal),
      emaOldestAgeSeconds: Math.round(this.adaptiveProfile.emaOldestAgeSeconds),
      profileSamples: this.adaptiveProfile.samples,
    }

    if (
      pressure.pendingTotalRecords >= this.SLO_PENDING_ERROR ||
      pressure.oldestPendingAgeSeconds >= this.SLO_OLDEST_AGE_ERROR_SEC
    ) {
      this.logger.error("Flush pressure SLO breached", fields)
      return
    }

    if (
      pressure.pendingTotalRecords >= this.SLO_PENDING_WARN ||
      pressure.oldestPendingAgeSeconds >= this.SLO_OLDEST_AGE_WARN_SEC
    ) {
      this.logger.warn("Flush pressure SLO near breach", fields)
      return
    }

    this.logger.info("Flush pressure SLO healthy", fields)
  }

  private async getFlushPressureSafe(): Promise<FlushPressureStats | null> {
    const { err, val } = await this.storage.getFlushPressure()
    if (err) {
      this.logger.warn("Unable to read flush pressure", { error: err.message })
      return null
    }
    return val
  }

  private resolveRoomScope(): {
    projectId: string
    customerId: string
  } | null {
    const roomName = this.name
    if (!roomName) {
      return null
    }

    const roomParts = roomName.split(":")
    if (roomParts.length < 3) {
      return null
    }

    const projectId = roomParts[roomParts.length - 2]
    const customerId = roomParts[roomParts.length - 1]

    if (!projectId || !customerId) {
      return null
    }

    return {
      projectId,
      customerId,
    }
  }

  private normalizeSnapshotWindowSeconds(value: unknown): 300 | 3600 | 86400 | 604800 | undefined {
    return value === 300 || value === 3600 || value === 86400 || value === 604800
      ? value
      : undefined
  }

  private async resolveRealtimeSubscriptionSnapshot(params: {
    customerId: string
    projectId: string
  }): Promise<RealtimeSubscriptionSnapshot | null> {
    const now = Date.now()
    const cached = this.subscriptionSnapshotCache
    if (cached && now - cached.fetchedAt < SUBSCRIPTION_SNAPSHOT_CACHE_TTL_MS) {
      return cached.value
    }

    const result = await this.customerService.getActiveSubscription({
      customerId: params.customerId,
      projectId: params.projectId,
      now,
      opts: {
        skipCache: false,
      },
    })

    if (result.err) {
      this.logger.warn("Failed to resolve realtime subscription for snapshot", {
        customerId: params.customerId,
        projectId: params.projectId,
        error: result.err.message,
      })
      return cached?.value ?? null
    }

    const activeSubscription = result.val
    const activePhase = activeSubscription.activePhase
    const billingConfig = activePhase?.planVersion?.billingConfig
    const billingInterval =
      billingConfig && typeof billingConfig === "object"
        ? (billingConfig as Record<string, unknown>).billingInterval
        : null

    const resolved: RealtimeSubscriptionSnapshot = {
      status: activeSubscription.status ?? null,
      planSlug: activeSubscription.planSlug ?? null,
      billingInterval: typeof billingInterval === "string" ? billingInterval : null,
      phaseStartAt: activePhase?.startAt ?? null,
      phaseEndAt: activePhase?.endAt ?? null,
      cycleStartAt: activeSubscription.currentCycleStartAt ?? null,
      cycleEndAt: activeSubscription.currentCycleEndAt ?? null,
      timezone: activeSubscription.timezone ?? null,
    }

    this.subscriptionSnapshotCache = {
      value: resolved,
      fetchedAt: now,
    }

    return resolved
  }

  // websocket events handlers
  onStart(): void | Promise<void> {
    this.logger.debug("onStart initializing do")
  }

  // when a websocket connection is established
  onConnect(connection: Connection<RealtimeConnectionState>): void | Promise<void> {
    this.logger.debug("onConnect", {
      connectionId: connection.id,
      room: this.name,
    })

    const now = Date.now()
    const tailEnabled = connection.tags.includes(CONNECTION_TAG_TAIL)

    // initialize channel state for cost controls
    connection.setState({
      joinedAt: now,
      tailActive: tailEnabled,
      tailExpiredAt: null,
    })
  }

  // when a websocket connection is closed
  onClose(): void | Promise<void> {
    // flush the metrics and logs
    this.ctx.waitUntil(
      (async () => {
        try {
          await Promise.all([
            this.metrics.flush().catch((err: Error) => {
              console.error("Failed to flush metrics in DO onClose", err)
            }),
            this.logger.flush().catch((err: Error) => {
              console.error("Failed to flush logger in DO onClose", err)
            }),
          ])
        } catch (error) {
          console.error("Error during background flush in DO onClose", error)
        }
      })()
    )
  }

  private sendMessage(conn: Connection<RealtimeConnectionState>, payload: Record<string, unknown>) {
    this.sendConnectionPayload(conn, JSON.stringify(payload))
  }

  private async handleResumeTailMessage(conn: Connection<RealtimeConnectionState>): Promise<void> {
    const now = Date.now()

    if (!conn.tags.includes(CONNECTION_TAG_TAIL)) {
      this.sendMessage(conn, {
        type: "tail_resume_error",
        message: "Tail channel is not enabled for this connection",
      })
      return
    }

    conn.setState({
      joinedAt: now,
      tailActive: true,
      tailExpiredAt: null,
    })
    this.sendMessage(conn, {
      type: "tail_resumed",
      timestamp: now,
    })
  }

  private async handleSnapshotRequestMessage(
    conn: Connection<RealtimeConnectionState>,
    payload: SnapshotRequestMessage
  ): Promise<void> {
    const scope = this.resolveRoomScope()
    if (!scope) {
      this.sendMessage(conn, {
        type: "snapshot_error",
        code: "FORBIDDEN",
        message: "Invalid realtime room scope",
      })
      return
    }

    const now = Date.now()
    const [metricsResult, entitlementsResult, allStatesResult, subscription] = await Promise.all([
      this.getBufferMetrics({
        windowSeconds: this.normalizeSnapshotWindowSeconds(payload.windowSeconds),
      }),
      this.getActiveEntitlements({
        customerId: scope.customerId,
        projectId: scope.projectId,
      }),
      this.storage.getAll(),
      this.resolveRealtimeSubscriptionSnapshot({
        customerId: scope.customerId,
        projectId: scope.projectId,
      }),
    ])

    if (metricsResult.err) {
      this.sendMessage(conn, {
        type: "snapshot_error",
        code: "INTERNAL",
        message: metricsResult.err.message,
      })
      return
    }

    const cachedEntitlements = this.entitlementsSnapshotCache
    const canUseCachedEntitlements =
      cachedEntitlements && now - cachedEntitlements.fetchedAt < SUBSCRIPTION_SNAPSHOT_CACHE_TTL_MS
    let entitlements = canUseCachedEntitlements ? (cachedEntitlements.value ?? []) : []
    if (entitlementsResult.err) {
      this.logger.warn("Failed to resolve active entitlements for snapshot", {
        customerId: scope.customerId,
        projectId: scope.projectId,
        error: entitlementsResult.err.message,
      })
    } else {
      entitlements = entitlementsResult.val
      this.entitlementsSnapshotCache = {
        value: entitlements,
        fetchedAt: now,
      }
    }

    const entitlementSlugs = new Set(entitlements.map((entitlement) => entitlement.featureSlug))
    const hasEntitlementsSource = !entitlementsResult.err || Boolean(canUseCachedEntitlements)
    let features: RealtimeFeatureSnapshot[] = []
    let usageByFeature: Record<string, number> = {}

    if (allStatesResult.err) {
      this.logger.warn("Failed to resolve in-memory usage for snapshot", {
        customerId: scope.customerId,
        projectId: scope.projectId,
        error: allStatesResult.err.message,
      })
    } else {
      const scopedStates = hasEntitlementsSource
        ? allStatesResult.val.filter((state) => entitlementSlugs.has(state.featureSlug))
        : allStatesResult.val

      features = buildRealtimeFeatures(scopedStates)
      usageByFeature = buildUsageByFeature(scopedStates)
    }

    const snapshotState = {
      customerId: scope.customerId,
      projectId: scope.projectId,
      subscriptionStatus: subscription?.status ?? null,
      subscription,
      entitlements,
      features,
      usageByFeature,
      metrics: metricsResult.val,
      asOf: Date.now(),
      stateVersion: `${metricsResult.val.newestTimestamp ?? 0}:${metricsResult.val.usageCount}:${metricsResult.val.verificationCount}:${entitlements.length}:${subscription?.cycleStartAt ?? 0}:${subscription?.status ?? "none"}`,
    }

    this.sendMessage(conn, {
      type: "snapshot",
      version: 3,
      metrics: metricsResult.val,
      usageByFeature,
      source: "durable_object",
      state: snapshotState,
    })
  }

  private async handleVerifyRequestMessage(
    conn: Connection<RealtimeConnectionState>,
    payload: VerifyRequestMessage
  ): Promise<void> {
    const scope = this.resolveRoomScope()
    const requestId =
      typeof payload.requestId === "string" && payload.requestId.trim().length > 0
        ? payload.requestId
        : crypto.randomUUID()

    if (!scope) {
      this.sendMessage(conn, {
        type: "verify_error",
        requestId,
        message: "Invalid realtime room scope",
      })
      return
    }

    const featureSlug = typeof payload.featureSlug === "string" ? payload.featureSlug.trim() : ""
    if (!featureSlug) {
      this.sendMessage(conn, {
        type: "verify_error",
        requestId,
        message: "featureSlug is required",
      })
      return
    }

    if (
      typeof payload.usage !== "undefined" &&
      (typeof payload.usage !== "number" || !Number.isFinite(payload.usage))
    ) {
      this.sendMessage(conn, {
        type: "verify_error",
        requestId,
        message: "usage must be a finite number",
      })
      return
    }

    let metadata: Record<string, string | number | boolean> | null
    try {
      metadata = normalizeWsMetadata(payload.metadata)
    } catch (error) {
      this.sendMessage(conn, {
        type: "verify_error",
        requestId,
        message: error instanceof Error ? error.message : "Invalid metadata payload",
      })
      return
    }

    const performanceStart = Date.now()
    const usage = typeof payload.usage === "number" ? payload.usage : undefined
    const verifyRequest: VerifyRequest = {
      customerId: scope.customerId,
      projectId: scope.projectId,
      featureSlug,
      usage,
      action: normalizeWsAction(payload.action),
      metadata,
      requestId,
      timestamp: performanceStart,
      performanceStart,
    }

    const result = await this.verify(verifyRequest)
    this.sendMessage(conn, {
      type: "verify_result",
      requestId,
      result,
    })
  }

  // websocket message handler
  async onMessage(conn: Connection<RealtimeConnectionState>, message: string) {
    // TODO: we should rate limit this
    try {
      const parsed = parseRealtimeClientMessage(message)
      if (!parsed.ok) {
        this.sendMessage(conn, {
          type: "message_error",
          message: parsed.error,
        })
        return
      }

      switch (parsed.value.type) {
        case "resume_tail": {
          await this.handleResumeTailMessage(conn)
          return
        }
        case "snapshot_request": {
          await this.handleSnapshotRequestMessage(conn, parsed.value)
          return
        }
        case "verify_request": {
          await this.handleVerifyRequestMessage(conn, parsed.value)
          return
        }
      }
    } catch (error) {
      this.logger.error("onMessage failed", {
        error: error instanceof Error ? error.message : "unknown error",
      })
    }
  }

  // when the alarm is triggered
  async onAlarm(): Promise<void> {
    this.logger.debug("Triggering alarm flush")

    const heartbeatFlushSec = this.getHeartbeatFlushSeconds()
    let nextFlushSec = heartbeatFlushSec

    try {
      let pressure = await this.getFlushPressureSafe()
      const shouldFlush = pressure === null || pressure.pendingTotalRecords > 0

      if (!shouldFlush) {
        this.logger.debug("Skipping alarm flush because buffer is empty")
      } else {
        const flushResult = await this.storage.flush()
        if (flushResult.err) {
          this.logger.error("Alarm flush failed", { error: flushResult.err.message })
        }
        pressure = await this.getFlushPressureSafe()
      }

      if (pressure) {
        nextFlushSec = this.getAdaptiveFlushSeconds(pressure, heartbeatFlushSec)
      }

      if (pressure && pressure.pendingTotalRecords > 0) {
        this.emitFlushPressureSlo("alarm", pressure)

        this.logger.info("Scheduled follow-up flush under pressure", {
          pendingTotalRecords: pressure.pendingTotalRecords,
          oldestPendingAgeSeconds: pressure.oldestPendingAgeSeconds,
          nextFlushSeconds: nextFlushSec,
        })
      }
    } catch (error) {
      this.logger.error("Unexpected alarm handler failure", {
        error: error instanceof Error ? error.message : "unknown error",
      })
    } finally {
      try {
        const nextAlarm = await this.scheduleAlarmWithHeartbeat(nextFlushSec)
        this.logger.debug("Scheduled alarm heartbeat", {
          nextAlarm: new Date(nextAlarm).toISOString(),
          nextFlushSeconds: nextFlushSec,
        })
      } catch (error) {
        this.logger.error("Failed to schedule alarm heartbeat", {
          error: error instanceof Error ? error.message : "unknown error",
        })
      }
    }

    // flush the metrics and logs
    this.ctx.waitUntil(
      (async () => {
        try {
          await Promise.all([
            this.metrics.flush().catch((err: Error) => {
              console.error("Failed to flush metrics in DO onAlarm", err)
            }),
            this.logger.flush().catch((err: Error) => {
              console.error("Failed to flush logger in DO onAlarm", err)
            }),
          ])
        } catch (error) {
          console.error("Error during background flush in DO onAlarm", error)
        }
      })()
    )
  }
}
