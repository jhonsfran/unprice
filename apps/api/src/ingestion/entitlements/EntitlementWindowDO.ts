import { DurableObject } from "cloudflare:workers"
import {
  Analytics,
  type AnalyticsEntitlementMeterFactV2,
  entitlementMeterFactSchemaV2,
} from "@unprice/analytics"
import {
  type ConfigFeatureVersionType,
  type OverageStrategy,
  calculatePricePerFeature,
  configFeatureSchema,
} from "@unprice/db/validators"
import { LEDGER_SCALE, diffLedgerMinor } from "@unprice/money"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  MAX_EVENT_AGE_MS,
  type MeterConfig,
  deriveMeterKey,
  findLimitExceededFact,
} from "@unprice/services/entitlements"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { z } from "zod"
import { apiDrain } from "~/observability"
import {
  idempotencyKeysTable,
  meterFactsOutboxTable,
  meterPricingTable,
  meterStateTable,
  schema,
} from "./db/schema"
import { DrizzleStorageAdapter } from "./drizzle-adapter"
import migrations from "./drizzle/migrations"

// All entitlements routed through this DO are usage-based
// (IngestionService filters on featureType === "usage" + meterConfig).
// We rate against the snapshotted price config as a usage feature.
const DO_FEATURE_TYPE = "usage" as const

class EntitlementWindowLimitExceededError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      limit: number
      valueAfter: number
    }
  ) {
    super(`Limit exceeded for meter ${params.meterKey}`)
    this.name = EntitlementWindowLimitExceededError.name
  }
}

class MeterPricingMismatchError extends Error {
  constructor(params: { meterKey: string; expected: string; received: string }) {
    super(
      `Plan version for meter ${params.meterKey} has changed: snapshotted ${params.expected}, got ${params.received}. A new entitlement requires a new DO instance.`
    )
    this.name = MeterPricingMismatchError.name
  }
}

type ApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

const outboxFactSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  idempotency_key: z.string(),
  project_id: z.string(),
  customer_id: z.string(),
  currency: z.string().length(3),
  stream_id: z.string(),
  feature_plan_version_id: z.string().nullable().optional(),
  feature_slug: z.string(),
  period_key: z.string(),
  event_slug: z.string(),
  aggregation_method: z.string(),
  timestamp: z.number(),
  created_at: z.number(),
  delta: z.number(),
  value_after: z.number(),
  // Signed integer at LEDGER_SCALE (6). Number (not bigint) — at scale 6,
  // Number.MAX_SAFE_INTEGER covers ~$9T, far beyond any plausible per-event
  // delta. Negative values represent corrections/refunds; clamping belongs
  // at invoicing.
  amount: z.number().int(),
  amount_scale: z.literal(LEDGER_SCALE),
  priced_at: z.number().int(),
})

type OutboxFact = z.infer<typeof outboxFactSchema>

type OutboxFlushRow = {
  id: number
  payload: string
}

const rawEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  timestamp: z.number(),
  properties: z.record(z.unknown()),
})

const overageStrategySchema = z.enum(["none", "last-call", "always"] satisfies readonly [
  OverageStrategy,
  ...OverageStrategy[],
])

const applyInputSchema = z.object({
  event: rawEventSchema,
  idempotencyKey: z.string().min(1),
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  currency: z.string().length(3),
  streamId: z.string().min(1),
  featurePlanVersionId: z.string().min(1),
  featureSlug: z.string().min(1),
  periodKey: z.string().min(1),
  meter: z.custom<MeterConfig>((val) => val != null && typeof val === "object"),
  priceConfig: configFeatureSchema,
  limit: z.number().finite().nullable().optional(),
  overageStrategy: overageStrategySchema.optional(),
  enforceLimit: z.boolean(),
  now: z.number(),
  periodEndAt: z.number().finite(),
})

type ApplyInput = z.infer<typeof applyInputSchema>

const FLUSH_BATCH_SIZE = 1000
const FLUSH_INTERVAL_MS = 30_000
const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 5000
const OUTBOX_DEPTH_ALERT_THRESHOLD = 1000

export class EntitlementWindowDO extends DurableObject {
  private readonly analytics: Analytics
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly logger: AppLogger
  private readonly ready: Promise<void>
  private periodEndAt: number | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    const requestId = this.ctx.id.toString()
    const { logger } = createStandaloneRequestLogger(
      {
        requestId,
      },
      {
        flush: apiDrain?.flush,
      }
    )

    this.logger = logger
    this.logger.set({
      requestId,
      service: "entitlementwindow",
      request: {
        id: requestId,
      },
      cloud: {
        platform: "cloudflare",
        durable_object_id: requestId,
      },
    })

    this.analytics = new Analytics({
      emit: true,
      tinybirdToken: env.TINYBIRD_TOKEN,
      tinybirdUrl: env.TINYBIRD_URL,
      logger: this.logger,
    })

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
    })
  }

  public async apply(rawInput: ApplyInput): Promise<ApplyResult> {
    await this.ready

    const input = applyInputSchema.parse(rawInput)

    const idempotencyKey = input.idempotencyKey
    const createdAt = Date.now()

    if (this.periodEndAt === null) {
      this.periodEndAt = input.periodEndAt
    }

    let insertedFactCount = 0

    try {
      const result = this.db.transaction((tx) => {
        const existing = tx
          .select({
            allowed: idempotencyKeysTable.allowed,
            deniedReason: idempotencyKeysTable.deniedReason,
            denyMessage: idempotencyKeysTable.denyMessage,
          })
          .from(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.eventId, idempotencyKey))
          .get()

        if (existing) {
          return {
            allowed: existing.allowed,
            deniedReason:
              (existing.deniedReason as ApplyResult["deniedReason"] | null | undefined) ??
              undefined,
            message: existing.denyMessage ?? undefined,
          }
        }

        const meterKey = deriveMeterKey(input.meter)

        // Snapshot price config on first apply; verify on every subsequent call.
        this.ensureMeterPricing(tx, {
          meterKey,
          priceConfig: input.priceConfig,
          currency: input.currency,
          pinnedPlanVersionId: input.featurePlanVersionId,
          createdAt,
        })

        const adapter = new DrizzleStorageAdapter(tx)
        const engine = new AsyncMeterAggregationEngine([input.meter], adapter, input.now)

        const facts = engine.applyEventSync(input.event, {
          // A limit hit is still a valid ingestion event. We store the denied
          // result in the DO idempotency table so queue retries stay stable,
          // while the ingestion service treats the event as processed.
          beforePersist: (pendingFacts) => {
            if (!input.enforceLimit) {
              return
            }

            const exceeded = findLimitExceededFact({
              facts: pendingFacts,
              limit: input.limit,
              overageStrategy: input.overageStrategy,
            })

            if (exceeded && typeof input.limit === "number" && Number.isFinite(input.limit)) {
              throw new EntitlementWindowLimitExceededError({
                eventId: input.event.id,
                meterKey: exceeded.meterKey,
                limit: input.limit,
                valueAfter: exceeded.valueAfter,
              })
            }
          },
        })

        insertedFactCount = facts.length

        for (const fact of facts) {
          const amountMinor = this.computeAmountMinor({
            fact,
            priceConfig: input.priceConfig,
          })

          const payload: OutboxFact = {
            id: [input.streamId, input.periodKey, input.event.id, fact.meterKey].join(":"),
            event_id: input.event.id,
            idempotency_key: input.idempotencyKey,
            project_id: input.projectId,
            customer_id: input.customerId,
            currency: input.currency,
            stream_id: input.streamId,
            feature_plan_version_id: input.featurePlanVersionId,
            feature_slug: input.featureSlug,
            period_key: input.periodKey,
            event_slug: input.event.slug,
            aggregation_method: input.meter.aggregationMethod,
            timestamp: input.event.timestamp,
            created_at: createdAt,
            delta: fact.delta,
            value_after: fact.valueAfter,
            amount: amountMinor,
            amount_scale: LEDGER_SCALE,
            priced_at: createdAt,
          }

          tx.insert(meterFactsOutboxTable)
            .values({
              payload: JSON.stringify(payload),
              currency: payload.currency,
            })
            .run()
        }

        tx.insert(idempotencyKeysTable)
          .values({
            eventId: idempotencyKey,
            createdAt,
            allowed: true,
            deniedReason: null,
            denyMessage: null,
          })
          .run()

        return { allowed: true } as ApplyResult
      })

      if (result.allowed && insertedFactCount > 0) {
        await this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS)
      }

      return result
    } catch (error) {
      if (error instanceof EntitlementWindowLimitExceededError) {
        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          message: error.message,
        }

        this.db
          .insert(idempotencyKeysTable)
          .values({
            eventId: idempotencyKey,
            createdAt,
            allowed: false,
            deniedReason: deniedResult.deniedReason ?? null,
            denyMessage: deniedResult.message ?? null,
          })
          .run()

        return deniedResult
      }

      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw error
      }

      throw error
    }
  }

  public async getEnforcementState(input: {
    limit?: number | null
    meterConfig: MeterConfig
    overageStrategy?: OverageStrategy | null
  }): Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }> {
    await this.ready

    const stateRow = this.db
      .select({
        value: meterStateTable.value,
      })
      .from(meterStateTable)
      .where(eq(meterStateTable.key, this.makeMeterStateKey(deriveMeterKey(input.meterConfig))))
      .get()

    const usage = Number(stateRow?.value ?? 0)
    const limit = this.normalizeLimit(input.limit)
    const isLimitReached =
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      input.overageStrategy !== "always" &&
      usage >= limit

    return {
      usage,
      limit,
      isLimitReached,
    }
  }

  async alarm(): Promise<void> {
    await this.ready

    const batch = this.db
      .select({
        id: meterFactsOutboxTable.id,
        payload: meterFactsOutboxTable.payload,
      })
      .from(meterFactsOutboxTable)
      .orderBy(asc(meterFactsOutboxTable.id))
      .limit(FLUSH_BATCH_SIZE)
      .all()

    if (batch.length > 0) {
      const didFlush = await this.flushToTinybird(batch)

      if (didFlush) {
        this.db
          .delete(meterFactsOutboxTable)
          .where(
            inArray(
              meterFactsOutboxTable.id,
              batch.map((row) => row.id)
            )
          )
          .run()
      }
    }

    // Keep idempotency keys for MAX_EVENT_AGE_MS (30 days). Cleanup is chunked
    // to avoid long synchronous SQLite write locks during large backlogs.
    const staleIdempotencyRows = this.db
      .select({ eventId: idempotencyKeysTable.eventId })
      .from(idempotencyKeysTable)
      .where(lt(idempotencyKeysTable.createdAt, Date.now() - MAX_EVENT_AGE_MS))
      .orderBy(asc(idempotencyKeysTable.createdAt))
      .limit(IDEMPOTENCY_CLEANUP_BATCH_SIZE)
      .all()

    if (staleIdempotencyRows.length > 0) {
      this.db
        .delete(idempotencyKeysTable)
        .where(
          inArray(
            idempotencyKeysTable.eventId,
            staleIdempotencyRows.map((row) => row.eventId)
          )
        )
        .run()
    }

    const remainingOutboxCount = this.getOutboxCount()

    this.logger.info("entitlement outbox depth", {
      outbox_depth: remainingOutboxCount,
      alert: remainingOutboxCount > OUTBOX_DEPTH_ALERT_THRESHOLD,
    })

    if (!this.periodEndAt) {
      // We don't know when the period ends, and outbox is empty.
      // Go to sleep. Next apply() will wake us up.
      return
    }

    // after the entitlement end we give 30 days to self destruct
    const selfDestructAt = this.periodEndAt + MAX_EVENT_AGE_MS

    if (Date.now() > selfDestructAt && remainingOutboxCount === 0) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    if (remainingOutboxCount > 0) {
      await this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS)
      return
    }

    // Outbox is empty, but we haven't reached self-destruct time.
    // Schedule one final alarm to wake up and die.
    await this.scheduleAlarm(selfDestructAt)
  }

  private ensureMeterPricing(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      meterKey: string
      priceConfig: ConfigFeatureVersionType
      currency: string
      pinnedPlanVersionId: string
      createdAt: number
    }
  ): void {
    const { meterKey, priceConfig, currency, pinnedPlanVersionId, createdAt } = params

    const existing = tx
      .select({ pinnedPlanVersionId: meterPricingTable.pinnedPlanVersionId })
      .from(meterPricingTable)
      .where(eq(meterPricingTable.meterKey, meterKey))
      .get()

    if (existing) {
      if (existing.pinnedPlanVersionId !== pinnedPlanVersionId) {
        throw new MeterPricingMismatchError({
          meterKey,
          expected: existing.pinnedPlanVersionId,
          received: pinnedPlanVersionId,
        })
      }
      return
    }

    tx.insert(meterPricingTable)
      .values({
        meterKey,
        currency,
        priceConfig,
        pinnedPlanVersionId,
        createdAt,
      })
      .run()
  }

  // Returns a signed integer at LEDGER_SCALE. Negative values are legitimate
  // (corrections/refunds); the invoicing layer is responsible for any sign
  // handling. We price against cumulative usage (after − before) so tier
  // boundaries are handled correctly, and skip the scale-2 quantization that
  // used to drop sub-cent amounts per event.
  private computeAmountMinor(params: {
    fact: Fact
    priceConfig: ConfigFeatureVersionType
  }): number {
    const { fact, priceConfig } = params

    if (fact.delta === 0) {
      return 0
    }

    const usageAfter = Math.max(0, fact.valueAfter)
    const usageBefore = Math.max(0, fact.valueAfter - fact.delta)

    const beforeResult = calculatePricePerFeature({
      quantity: usageBefore,
      featureType: DO_FEATURE_TYPE,
      config: priceConfig,
    })

    if (beforeResult.err) {
      throw beforeResult.err
    }

    const afterResult = calculatePricePerFeature({
      quantity: usageAfter,
      featureType: DO_FEATURE_TYPE,
      config: priceConfig,
    })
    if (afterResult.err) {
      throw afterResult.err
    }

    return diffLedgerMinor(afterResult.val.totalPrice.dinero, beforeResult.val.totalPrice.dinero)
  }

  private async flushToTinybird(batch: OutboxFlushRow[]): Promise<boolean> {
    let facts: AnalyticsEntitlementMeterFactV2[]

    try {
      facts = batch.map((row) => entitlementMeterFactSchemaV2.parse(JSON.parse(row.payload)))
    } catch (error) {
      this.logger.error("Failed to parse entitlement meter fact outbox payload", {
        error: this.errorMessage(error),
        batchSize: batch.length,
      })
      return false
    }

    try {
      const result = await this.analytics.ingestEntitlementMeterFactsV2(facts)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0

      if (successful === facts.length && quarantined === 0) {
        return true
      }

      this.logger.error("Tinybird entitlement meter facts ingestion failed", {
        expected: facts.length,
        successful,
        quarantined,
      })
    } catch (error) {
      this.logger.error("Failed to ingest entitlement meter facts to Tinybird", {
        error: this.errorMessage(error),
        batchSize: facts.length,
      })
    }

    return false
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return String(error ?? "unknown error")
  }

  private getOutboxCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(meterFactsOutboxTable).get()
    return Number(row?.count ?? 0)
  }

  private normalizeLimit(limit: number | null | undefined): number | null {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return null
    }
    return limit
  }

  private makeMeterStateKey(meterKey: string): string {
    return `meter-state:${meterKey}`
  }

  private async scheduleAlarm(target: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null && existing <= target) return
    await this.ctx.storage.setAlarm(target)
  }
}
