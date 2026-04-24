import { DurableObject } from "cloudflare:workers"
import {
  Analytics,
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import type { Currency } from "@unprice/db/validators"
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
import { LedgerGateway } from "@unprice/services/ledger"
import { WalletService } from "@unprice/services/wallet"
import { LocalReservation, thresholdFromBps } from "@unprice/services/wallet/local-reservation"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { z } from "zod"
import type { Env } from "~/env"
import { apiDrain } from "~/observability"
import { idempotencyKeysTable, meterFactsOutboxTable, meterWindowTable, schema } from "./db/schema"
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

// Raised when a priced event's cost exceeds the local reservation's
// remaining allocation (Phase 7). The DO converts this into a denied
// ApplyResult, persists the denial to the idempotency table, and returns
// WALLET_EMPTY so retries are stable.
class EntitlementWindowWalletEmptyError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      reservationId: string
      cost: number
      remaining: number
    }
  ) {
    super(`Wallet empty for meter ${params.meterKey} (reservation ${params.reservationId})`)
    this.name = EntitlementWindowWalletEmptyError.name
  }
}

type DeniedReason = "LIMIT_EXCEEDED" | "WALLET_EMPTY"

type ApplyResult = {
  allowed: boolean
  deniedReason?: DeniedReason
  message?: string
}

// Internal: bubbled out of the apply() transaction so the post-commit
// scheduler can fire `ctx.waitUntil(requestFlushAndRefill(...))` without
// holding the tx open. Amounts are pgledger scale-8 minor units.
type RefillTrigger = {
  flushSeq: number
  flushAmount: number
  refillChunkAmount: number
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
  // Signed integer at LEDGER_SCALE (8). Number (not bigint) — at scale 8,
  // Number.MAX_SAFE_INTEGER covers ~$90M per event, far beyond any plausible
  // per-event delta. Negative values represent corrections/refunds; clamping
  // belongs at invoicing.
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

type EnforcementCache = {
  limit: number | null
  usage: number
  lastUpdate: number
  isLimitReached: boolean
}

export class EntitlementWindowDO extends DurableObject {
  private readonly analytics: Analytics
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly logger: AppLogger
  private readonly ready: Promise<void>
  private readonly runtimeEnv: Env
  // In-memory source of truth for enforcement checks. Populated by apply()
  // after a successful commit with the limit/overageStrategy it received;
  // on DO eviction the cache is lost and the next apply rebuilds it.
  // periodEndAt is intentionally *not* cached in memory — alarm() reads it
  // from SQLite directly since the path is rare (every 30s at most).
  private cache: EnforcementCache | null = null
  // Lazily constructed on the first flush+refill call so a DO that never
  // opens a reservation never opens a Postgres connection.
  private walletService: WalletService | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as unknown as Cloudflare.Env)

    this.runtimeEnv = env

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

      // Seed usage from SQLite if we already have a window row. limit and
      // overageStrategy are not persisted, so we can't fully rehydrate
      // isLimitReached — we leave the cache null and let the next apply()
      // populate it with current caller context. Callers hitting
      // getEnforcementState before the next apply see usage from SQLite
      // and no limit enforcement (apply() will still enforce).
      const row = this.db
        .select({ usage: meterWindowTable.usage, updatedAt: meterWindowTable.updatedAt })
        .from(meterWindowTable)
        .get()

      if (row) {
        this.cache = {
          limit: null,
          usage: Number(row.usage),
          lastUpdate: row.updatedAt ?? 0,
          isLimitReached: false,
        }
      }

      // Crash recovery (Phase 7.5). If the DO was evicted mid-flush, the
      // SQLite row still carries `pending_flush_seq > flush_seq`. Re-issue
      // the flush with the same seq — WalletService dedupes via the ledger
      // idempotency key `flush:{reservationId}:{flushSeq}`, so a duplicate
      // call after a successful commit is a no-op. `flushAmount` is
      // re-derived from `consumed - flushed` because we don't persist the
      // pending flush amount separately; any events accepted after the
      // failed flush are folded into the retry, which is correct.
      const window = this.readWalletWindow(this.db)
      if (
        window?.reservationId &&
        window.pendingFlushSeq !== null &&
        window.pendingFlushSeq !== undefined &&
        window.pendingFlushSeq > window.flushSeq
      ) {
        const flushAmount = Math.max(0, window.consumedAmount - window.flushedAmount)
        this.ctx.waitUntil(
          this.requestFlushAndRefill({
            flushSeq: window.pendingFlushSeq,
            flushAmount,
            refillChunkAmount: window.refillChunkAmount,
          })
        )
      }
    })
  }

  public async apply(rawInput: ApplyInput): Promise<ApplyResult> {
    await this.ready

    const input = applyInputSchema.parse(rawInput)

    const idempotencyKey = input.idempotencyKey
    const createdAt = Date.now()

    let insertedFactCount = 0
    let nextUsage: number | null = null
    let refillTrigger: RefillTrigger | null = null

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

        // Snapshot price config + periodEndAt on first apply; ensure the
        // singleton window row exists before the engine's adapter UPDATEs
        // its usage/updatedAt columns. The streamId already guarantees
        // meter/reset fungibility, so we don't pin the featurePlanVersionId
        // — stacked grants from different fpvs are valid on the same stream.
        this.ensureMeterWindow(tx, {
          meterKey,
          projectId: input.projectId,
          customerId: input.customerId,
          priceConfig: input.priceConfig,
          currency: input.currency,
          periodEndAt: input.periodEndAt,
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

        // Price every fact once — the wallet check needs the summed cost
        // and the outbox rows need the per-fact amount, so we compute both
        // from the same pass. Negative amounts are valid (corrections).
        const pricedFacts = facts.map((fact) => ({
          fact,
          amountMinor: this.computeAmountMinor({ fact, priceConfig: input.priceConfig }),
        }))

        // Phase 7 wallet check. Only engages when a reservation has been
        // opened on this window (activation path, slice 7.12). Without a
        // reservation the DO operates in the pre-wallet behaviour: no
        // allocation tracking, no refill trigger.
        const window = this.readWalletWindow(tx)
        if (window?.reservationId && pricedFacts.length > 0) {
          const totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)

          const local = new LocalReservation(
            thresholdFromBps(window.allocationAmount, window.refillThresholdBps),
            window.refillChunkAmount
          )

          const walletResult = local.applyUsage(
            {
              allocationAmount: window.allocationAmount,
              consumedAmount: window.consumedAmount,
            },
            totalCost
          )

          if (!walletResult.isAllowed) {
            throw new EntitlementWindowWalletEmptyError({
              eventId: input.event.id,
              meterKey,
              reservationId: window.reservationId,
              cost: totalCost,
              remaining: window.allocationAmount - window.consumedAmount,
            })
          }

          // Synchronous SQLite write before any post-commit action. On
          // replay the idempotency row short-circuits above, so this only
          // runs on the first-success path.
          tx.update(meterWindowTable)
            .set({ consumedAmount: walletResult.newState.consumedAmount })
            .run()

          if (walletResult.needsRefill && !window.refillInFlight) {
            const nextSeq = window.flushSeq + 1

            tx.update(meterWindowTable)
              .set({ refillInFlight: true, pendingFlushSeq: nextSeq })
              .run()

            refillTrigger = {
              flushSeq: nextSeq,
              // Flush leg = cumulative consumed - already flushed. Zero on the
              // first refill means `flushReservation` skips the recognize leg.
              flushAmount: walletResult.newState.consumedAmount - window.flushedAmount,
              refillChunkAmount: walletResult.refillRequestAmount,
            }
          }
        }

        for (const { fact, amountMinor } of pricedFacts) {
          nextUsage = fact.valueAfter

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

      // Commit succeeded — refresh the enforcement cache with this
      // apply's context. Idempotent replays return early with facts = []
      // and nextUsage stays null, so we keep the previous cache
      // (SQLite wasn't touched either).
      if (nextUsage !== null) {
        const limit = this.normalizeLimit(input.limit)
        this.cache = {
          limit,
          usage: nextUsage,
          lastUpdate: createdAt,
          isLimitReached: this.computeLimitReached(nextUsage, limit, input.overageStrategy),
        }
      }

      if (result.allowed && insertedFactCount > 0) {
        await this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS)
      }

      // Flush+refill must happen after commit so the new consumed/refill
      // state is visible to `requestFlushAndRefill`, and must outlive the
      // request via `ctx.waitUntil` so it continues after apply() returns.
      if (refillTrigger) {
        this.ctx.waitUntil(this.requestFlushAndRefill(refillTrigger))
      }

      return result
    } catch (error) {
      if (error instanceof EntitlementWindowLimitExceededError) {
        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          message: error.message,
        }

        // limit exceeded is a valid state
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

      if (error instanceof EntitlementWindowWalletEmptyError) {
        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "WALLET_EMPTY",
          message: error.message,
        }

        // wallet empty is a valid state as well.
        // TODO: probably we need to check the edge case where the reservation is not enough but
        // there is still balance in the wallet
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

  public async getEnforcementState(): Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }> {
    await this.ready

    // cache is populated at initialization
    if (this.cache) {
      return {
        usage: this.cache.usage,
        limit: this.cache.limit,
        isLimitReached: this.cache.isLimitReached,
      }
    }

    // No apply on this instance yet and no prior row in SQLite either —
    // apply() will re-enforce with real context when it runs.
    return { usage: 0, limit: null, isLimitReached: false }
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
      // this can create double counting on fail but tinybird has
      // dedupe protection, also the arch reads the last event value_after
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

    // keep an eye on this
    this.logger.info("entitlement outbox depth", {
      outbox_depth: remainingOutboxCount,
      alert: remainingOutboxCount > OUTBOX_DEPTH_ALERT_THRESHOLD,
    })

    // Read periodEndAt from SQLite on demand — the alarm runs at most once
    // per FLUSH_INTERVAL_MS, so avoiding an in-memory mirror removes a
    // source of drift without any measurable cost.
    const periodEndAt = this.readPeriodEndAt()

    if (!periodEndAt) {
      // We don't know when the period ends, and outbox is empty.
      // Go to sleep. Next apply() will wake us up.
      return
    }

    // after the entitlement end we give 30 days to self destruct
    const selfDestructAt = periodEndAt + MAX_EVENT_AGE_MS

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

  private ensureMeterWindow(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      meterKey: string
      projectId: string
      customerId: string
      priceConfig: ConfigFeatureVersionType
      currency: string
      periodEndAt: number
      createdAt: number
    }
  ): void {
    tx.insert(meterWindowTable)
      .values({
        meterKey: params.meterKey,
        projectId: params.projectId,
        customerId: params.customerId,
        currency: params.currency,
        priceConfig: params.priceConfig,
        periodEndAt: params.periodEndAt,
        usage: 0,
        updatedAt: null,
        createdAt: params.createdAt,
      })
      .onConflictDoNothing({ target: meterWindowTable.meterKey })
      .run()
  }

  private readPeriodEndAt(): number | null {
    const row = this.db
      .select({ periodEndAt: meterWindowTable.periodEndAt })
      .from(meterWindowTable)
      .get()
    return row?.periodEndAt ?? null
  }

  // Read the reservation-relevant fields in one shot. Returns `null` when
  // no window row exists yet (pre-first-apply). A row with a null
  // `reservationId` means the DO is operating without a reservation —
  // callers must treat that as "skip wallet check".
  private readWalletWindow(tx: DrizzleSqliteDODatabase<typeof schema>): {
    projectId: string | null
    customerId: string | null
    currency: string
    periodEndAt: number | null
    reservationId: string | null
    allocationAmount: number
    consumedAmount: number
    flushedAmount: number
    refillThresholdBps: number
    refillChunkAmount: number
    refillInFlight: boolean
    flushSeq: number
    pendingFlushSeq: number | null
  } | null {
    const row = tx
      .select({
        projectId: meterWindowTable.projectId,
        customerId: meterWindowTable.customerId,
        currency: meterWindowTable.currency,
        periodEndAt: meterWindowTable.periodEndAt,
        reservationId: meterWindowTable.reservationId,
        allocationAmount: meterWindowTable.allocationAmount,
        consumedAmount: meterWindowTable.consumedAmount,
        flushedAmount: meterWindowTable.flushedAmount,
        refillThresholdBps: meterWindowTable.refillThresholdBps,
        refillChunkAmount: meterWindowTable.refillChunkAmount,
        refillInFlight: meterWindowTable.refillInFlight,
        flushSeq: meterWindowTable.flushSeq,
        pendingFlushSeq: meterWindowTable.pendingFlushSeq,
      })
      .from(meterWindowTable)
      .get()

    if (!row) return null

    return {
      projectId: row.projectId ?? null,
      customerId: row.customerId ?? null,
      currency: String(row.currency ?? ""),
      periodEndAt: row.periodEndAt ?? null,
      reservationId: row.reservationId ?? null,
      allocationAmount: Number(row.allocationAmount ?? 0),
      consumedAmount: Number(row.consumedAmount ?? 0),
      flushedAmount: Number(row.flushedAmount ?? 0),
      refillThresholdBps: Number(row.refillThresholdBps ?? 0),
      refillChunkAmount: Number(row.refillChunkAmount ?? 0),
      refillInFlight: Boolean(row.refillInFlight),
      flushSeq: Number(row.flushSeq ?? 0),
      pendingFlushSeq: row.pendingFlushSeq ?? null,
    }
  }

  // Slice 7.5. Calls WalletService.flushReservation in-process and folds the returned
  // allocation/flush delta back into the DO's SQLite state.
  //
  // `flushSeq` is the idempotency seal: the ledger dedupes on
  // `flush:{reservationId}:{flushSeq}`, so replays after a crash produce
  // the same outcome. On error we only clear `refillInFlight` — the
  // `pendingFlushSeq` stays set so crash recovery (or the next apply()
  // that observes `pendingFlushSeq > flushSeq`) can retry with the same
  // seq. Crucially we do not advance `flushedAmount` on failure: the next
  // retry re-derives `flushAmount` from `consumedAmount - flushedAmount`.
  private async requestFlushAndRefill(trigger: RefillTrigger): Promise<void> {
    const window = this.readWalletWindow(this.db)

    if (!window?.reservationId || !window.projectId || !window.customerId) {
      this.logger.error("flush+refill requested without a reservation", {
        flushSeq: trigger.flushSeq,
        flushAmount: trigger.flushAmount,
        refillChunkAmount: trigger.refillChunkAmount,
      })
      this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
      return
    }

    try {
      const walletService = this.getWalletService()
      const result = await walletService.flushReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: trigger.flushSeq,
        flushAmount: trigger.flushAmount,
        refillChunkAmount: trigger.refillChunkAmount,
        // We keep stable statement for invoicing
        statementKey: `${window.reservationId}:${window.periodEndAt ?? 0}`,
        final: false,
      })

      if (result.err) {
        this.logger.error("flush+refill failed", {
          error: result.err.message,
          flushSeq: trigger.flushSeq,
          reservationId: window.reservationId,
        })
        // Clear the single-flight flag so apply() can re-trigger on the
        // next event; leave pendingFlushSeq set so crash recovery picks up
        // the same seq after an eviction.
        this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
        return
      }

      this.db
        .update(meterWindowTable)
        .set({
          allocationAmount: window.allocationAmount + result.val.grantedAmount,
          flushedAmount: window.flushedAmount + result.val.flushedAmount,
          flushSeq: trigger.flushSeq,
          pendingFlushSeq: null,
          refillInFlight: false,
        })
        .run()
    } catch (error) {
      this.logger.error("flush+refill threw unexpectedly", {
        error: this.errorMessage(error),
        flushSeq: trigger.flushSeq,
      })
      this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
    }
  }

  // Construct the wallet service on first use. Each DO instance opens at
  // most one connection — pool lifetime is the DO's lifetime.
  private getWalletService(): WalletService {
    if (this.walletService) return this.walletService

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: this.runtimeEnv.DRIZZLE_LOG?.toString() === "true",
      singleton: false,
    })

    const ledger = new LedgerGateway({ db, logger: this.logger })
    this.walletService = new WalletService({
      db,
      logger: this.logger,
      ledgerGateway: ledger,
    })
    return this.walletService
  }

  private computeLimitReached(
    usage: number,
    limit: number | null,
    overageStrategy: OverageStrategy | undefined
  ): boolean {
    return (
      typeof limit === "number" &&
      Number.isFinite(limit) &&
      overageStrategy !== "always" &&
      usage >= limit
    )
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

    // we calculate the before and the after because tier prices can
    // fall in a different tier, so calculating deltas prices wouldn't be correct
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
    let facts: AnalyticsEntitlementMeterFact[]

    try {
      facts = batch.map((row) => entitlementMeterFactSchemaV1.parse(JSON.parse(row.payload)))
    } catch (error) {
      this.logger.error("Failed to parse entitlement meter fact outbox payload", {
        error: this.errorMessage(error),
        batchSize: batch.length,
      })
      return false
    }

    try {
      const result = await this.analytics.ingestEntitlementMeterFacts(facts)
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

  private async scheduleAlarm(target: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null && existing <= target) return
    await this.ctx.storage.setAlarm(target)
  }
}
