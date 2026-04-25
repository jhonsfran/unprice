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
import type { AppLogger } from "@unprice/observability"
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
// Pure helper — direct path avoids the use-cases barrel and the
// drizzle relations import chain it transitively pulls in.
import { sizeReservation } from "@unprice/services/wallet/reservation-sizing"
import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { z } from "zod"
import type { Env } from "~/env"
import { createDoLogger, runDoOperation } from "~/observability"
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
  periodStartAt: z.number().finite(),
  periodEndAt: z.number().finite(),
})

type ApplyInput = z.infer<typeof applyInputSchema>

const FLUSH_BATCH_SIZE = 1000
const FLUSH_INTERVAL_MS = 30_000
const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 5000
const OUTBOX_DEPTH_ALERT_THRESHOLD = 1000
// 24h of radio silence closes out a live reservation even if the period
// hasn't ended. The final flush returns remaining reserved funds to
// `available.purchased`; a future apply() on this DO runs without a
// reservation until activateEntitlement opens a new one.
const INACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000

// Maximum time the DO will let consumed-but-unflushed activity sit in
// `customer.{cid}.reserved` without recognising it in the ledger. Cold
// meters that never cross `refillThresholdBps` would otherwise stay
// invisible until period_end / inactivity; this caps that delay so
// dashboards and reconcilers see a freshness floor instead.
//
// Tight in dev (30s) so the user sees movement quickly while debugging;
// 5 min in deployed environments balances ledger freshness against the
// per-flush Postgres roundtrip cost on cold meters.
function maxFlushIntervalMs(env: Env): number {
  return env.NODE_ENV === "development" ? 30_000 : 5 * 60_000
}

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
    this.logger = createDoLogger(requestId)
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

    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "apply",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => this.applyInner(rawInput)
    )
  }

  private async applyInner(rawInput: ApplyInput): Promise<ApplyResult> {
    const startTime = Date.now()
    const input = applyInputSchema.parse(rawInput)

    const idempotencyKey = input.idempotencyKey
    const createdAt = Date.now()
    const meterKey = deriveMeterKey(input.meter)

    // One canonical log line per apply() — populated as we go, emitted in
    // the finally block so every code path (success, denial, throw) lands
    // in the same wide event.
    const wideEvent: Record<string, unknown> = {
      operation: "apply",
      event_id: input.event.id,
      event_slug: input.event.slug,
      event_timestamp: input.event.timestamp,
      idempotency_key: idempotencyKey,
      project_id: input.projectId,
      customer_id: input.customerId,
      currency: input.currency,
      stream_id: input.streamId,
      feature_plan_version_id: input.featurePlanVersionId,
      feature_slug: input.featureSlug,
      period_key: input.periodKey,
      period_start_at: input.periodStartAt,
      period_end_at: input.periodEndAt,
      meter_key: meterKey,
      aggregation_method: input.meter.aggregationMethod,
      enforce_limit: input.enforceLimit,
      limit: input.limit ?? null,
      overage_strategy: input.overageStrategy ?? null,
      usage_before: this.cache?.usage ?? null,
      cache_limit_reached_before: this.cache?.isLimitReached ?? false,
    }

    let result: ApplyResult | undefined
    let thrown: unknown
    let insertedFactCount = 0
    let nextUsage: number | null = null
    let refillTrigger: RefillTrigger | null = null
    let totalCost = 0
    let reservationEngaged = false

    try {
      // Idempotency short-circuit before any wallet I/O. A retried event with a
      // cached result must not re-call wallet.createReservation.
      const cachedResult = this.lookupCachedIdempotencyResult(idempotencyKey)
      if (cachedResult) {
        wideEvent.idempotent_replay = true
        result = cachedResult
        return cachedResult
      }
      wideEvent.idempotent_replay = false

      // Phase 7.13 — lazy reservation bootstrap. If this DO has never opened a
      // reservation for the current period (or the previous one closed at period
      // end / inactivity), open one now against the customer wallet. The
      // reservation row is the contract the in-tx LocalReservation check needs;
      // without it the DO falls through to pre-wallet behavior (no enforcement).
      //
      // Out-of-tx because Postgres ↔ SQLite can't share a single transaction.
      // The DO is single-writer per (customer, stream, period), so there's no
      // race with a concurrent apply().
      const preWindow = this.readWalletWindow(this.db)
      // Skip the wallet round-trip when the cache already says this stream is
      // capped — the in-tx limit check will re-deny, and bootstrapping a fresh
      // reservation only to immediately close it on the next limit hit is
      // pure churn against the customer wallet.
      const needsBootstrap =
        (!preWindow || preWindow.reservationId === null) && !this.cache?.isLimitReached
      wideEvent.bootstrap_attempted = needsBootstrap

      if (needsBootstrap) {
        const denial = await this.bootstrapReservation(input)
        if (denial) {
          wideEvent.bootstrap_outcome = "denied"
          // Persist the denial idempotently so retries return the same answer
          // without re-calling the wallet. The DO's normal denial-cache pattern.
          this.db
            .insert(idempotencyKeysTable)
            .values({
              eventId: idempotencyKey,
              createdAt,
              allowed: false,
              deniedReason: denial.deniedReason ?? null,
              denyMessage: denial.message ?? null,
            })
            .run()
          result = denial
          return denial
        }
        wideEvent.bootstrap_outcome = "success"
      } else {
        wideEvent.bootstrap_outcome = preWindow?.reservationId
          ? "reservation_already_open"
          : "skipped_capped"
      }

      try {
        const txResult = this.db.transaction((tx) => {
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
            reservationEngaged = true
            totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)

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

          // Stamp the inactivity watermark on every successful commit. alarm()
          // uses `now - lastEventAt > INACTIVITY_THRESHOLD_MS` to decide when to
          // close out a dormant reservation without waiting for period end.
          tx.update(meterWindowTable).set({ lastEventAt: createdAt }).run()

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

        if (txResult.allowed && insertedFactCount > 0) {
          await this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS)
        }

        // Flush+refill must happen after commit so the new consumed/refill
        // state is visible to `requestFlushAndRefill`, and must outlive the
        // request via `ctx.waitUntil` so it continues after apply() returns.
        if (refillTrigger) {
          this.ctx.waitUntil(this.requestFlushAndRefill(refillTrigger))
        }

        result = txResult
        return txResult
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

          // Distinguish two cases:
          //   (a) The *committed* usage is already at or above the limit. Every
          //       future event on this period will also fail the limit check.
          //       The reservation is dead weight — close it so the remainder
          //       returns to `available.purchased`.
          //   (b) Committed usage is still below the limit, but this single
          //       event's delta would have pushed past it (e.g. a one-shot
          //       large delta on an otherwise-quiet period). Future smaller
          //       events can still draw on this reservation, so we leave it
          //       open and only deny *this* event.
          const previousUsage = this.cache?.usage ?? 0
          const trulyCapped =
            input.overageStrategy !== "always" &&
            typeof input.limit === "number" &&
            Number.isFinite(input.limit) &&
            previousUsage >= input.limit

          wideEvent.truly_capped = trulyCapped

          if (trulyCapped) {
            this.cache = {
              limit: input.limit ?? null,
              usage: previousUsage,
              lastUpdate: createdAt,
              isLimitReached: true,
            }

            const window = this.readWalletWindow(this.db)
            if (window?.reservationId) {
              await this.finalFlush(window)
            }
          }

          result = deniedResult
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

          result = deniedResult
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
    } catch (error) {
      thrown = error
      throw error
    } finally {
      wideEvent.fact_count = insertedFactCount
      wideEvent.usage_after = nextUsage
      wideEvent.cost_minor = totalCost
      wideEvent.reservation_engaged = reservationEngaged

      // refillTrigger is assigned inside a transaction callback, which
      // defeats TS flow analysis here — it still thinks the value is `null`.
      const trigger = refillTrigger as RefillTrigger | null
      wideEvent.refill_triggered = trigger !== null
      if (trigger) {
        wideEvent.refill_seq = trigger.flushSeq
        wideEvent.refill_chunk_amount = trigger.refillChunkAmount
        wideEvent.refill_flush_amount = trigger.flushAmount
      }
      wideEvent.duration_ms = Date.now() - startTime

      if (result) {
        wideEvent.allowed = result.allowed
        wideEvent.denied_reason = result.deniedReason ?? null
        wideEvent.outcome = result.allowed ? "success" : "denied"
      } else if (thrown) {
        wideEvent.outcome = "error"
        wideEvent.error_type = thrown instanceof Error ? thrown.name : "unknown"
        wideEvent.error_message = thrown instanceof Error ? thrown.message : String(thrown)
      }

      this.logger.info("entitlement apply", wideEvent)
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

    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "alarm",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => this.alarmInner()
    )
  }

  private async alarmInner(): Promise<void> {
    const startTime = Date.now()
    const wideEvent: Record<string, unknown> = {
      operation: "alarm",
    }

    let thrown: unknown

    try {
      const batch = this.db
        .select({
          id: meterFactsOutboxTable.id,
          payload: meterFactsOutboxTable.payload,
        })
        .from(meterFactsOutboxTable)
        .orderBy(asc(meterFactsOutboxTable.id))
        .limit(FLUSH_BATCH_SIZE)
        .all()

      wideEvent.outbox_batch_size = batch.length
      let outboxFlushed = false

      if (batch.length > 0) {
        // this can create double counting on fail but tinybird has
        // dedupe protection, also the arch reads the last event value_after
        outboxFlushed = await this.flushToTinybird(batch)

        if (outboxFlushed) {
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
      wideEvent.outbox_flushed = outboxFlushed

      // Keep idempotency keys for MAX_EVENT_AGE_MS (30 days). Cleanup is chunked
      // to avoid long synchronous SQLite write locks during large backlogs.
      const staleIdempotencyRows = this.db
        .select({ eventId: idempotencyKeysTable.eventId })
        .from(idempotencyKeysTable)
        .where(lt(idempotencyKeysTable.createdAt, Date.now() - MAX_EVENT_AGE_MS))
        .orderBy(asc(idempotencyKeysTable.createdAt))
        .limit(IDEMPOTENCY_CLEANUP_BATCH_SIZE)
        .all()

      wideEvent.idempotency_cleaned = staleIdempotencyRows.length

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
      wideEvent.outbox_remaining = remainingOutboxCount
      wideEvent.outbox_alert = remainingOutboxCount > OUTBOX_DEPTH_ALERT_THRESHOLD

      // Phase 7.7 final-flush detection. Any of three triggers converges on
      // the same flush path: period end, 24h inactivity, or an explicit
      // deletion request. A DO without a reservation (or one marked
      // `recoveryRequired`) skips the flush — there's nothing to close out
      // or the last attempt failed terminally and an operator has to look.
      const window = this.readWalletWindow(this.db)
      const now = Date.now()

      wideEvent.reservation_id = window?.reservationId ?? null
      wideEvent.recovery_required = window?.recoveryRequired ?? false

      if (window?.reservationId && !window.recoveryRequired) {
        const isPeriodEnd = window.periodEndAt !== null && now >= window.periodEndAt
        const isInactive =
          window.lastEventAt !== null && now - window.lastEventAt > INACTIVITY_THRESHOLD_MS
        const isDeletionPending = window.deletionRequested

        if (isPeriodEnd || isInactive || isDeletionPending) {
          wideEvent.final_flush_reason = isDeletionPending
            ? "deletion"
            : isPeriodEnd
              ? "period_end"
              : "inactivity"
          await this.finalFlush(window)

          if (isDeletionPending) {
            // Flush result is best-effort under deletion — whether it
            // succeeded or not, the caller asked us to die. A failure has
            // already been logged inside finalFlush; the ledger idempotency
            // row lets an operator replay the capture if needed.
            wideEvent.self_destruct = true
            wideEvent.outcome = "deleted"
            await this.ctx.storage.deleteAlarm()
            await this.ctx.storage.deleteAll()
            return
          }
        }
      }

      // Time-based flush: if a reservation is still open with unflushed
      // consumption that hasn't been recognised in the ledger for longer
      // than the max flush interval, push a non-final flush so cold meters
      // surface their consumption on a predictable cadence rather than
      // waiting for the refill threshold or period_end.
      //
      // Re-read the window because finalFlush above may have closed it.
      // `refillInFlight` guards against a concurrent apply()-triggered refill
      // (single-threaded per DO, but the apply path's `ctx.waitUntil` can
      // outlive the request and we don't want the alarm to race it).
      const flushIntervalMs = maxFlushIntervalMs(this.runtimeEnv)
      const postFlushWindow = this.readWalletWindow(this.db)
      let timeFlushTriggered = false
      if (
        postFlushWindow?.reservationId &&
        !postFlushWindow.recoveryRequired &&
        !postFlushWindow.refillInFlight
      ) {
        const unflushed = Math.max(
          0,
          postFlushWindow.consumedAmount - postFlushWindow.flushedAmount
        )
        const elapsedSinceLastFlush =
          postFlushWindow.lastFlushedAt !== null
            ? now - postFlushWindow.lastFlushedAt
            : Number.POSITIVE_INFINITY

        if (unflushed > 0 && elapsedSinceLastFlush >= flushIntervalMs) {
          timeFlushTriggered = true
          const nextSeq = postFlushWindow.flushSeq + 1
          wideEvent.time_flush_seq = nextSeq
          wideEvent.time_flush_amount = unflushed
          this.db
            .update(meterWindowTable)
            .set({ refillInFlight: true, pendingFlushSeq: nextSeq })
            .run()
          await this.requestFlushAndRefill({
            flushSeq: nextSeq,
            flushAmount: unflushed,
            // Time-driven flush is purely about ledger freshness — don't
            // top up allocation here. The DO's own refill trigger handles
            // that when the threshold is actually crossed.
            refillChunkAmount: 0,
          })
        }
      }
      wideEvent.time_flush_triggered = timeFlushTriggered

      // Read periodEndAt from SQLite on demand — the alarm runs at most once
      // per FLUSH_INTERVAL_MS, so avoiding an in-memory mirror removes a
      // source of drift without any measurable cost.
      const periodEndAt = this.readPeriodEndAt()
      wideEvent.period_end_at = periodEndAt

      if (!periodEndAt) {
        // We don't know when the period ends, and outbox is empty.
        // Go to sleep. Next apply() will wake us up.
        wideEvent.outcome = "idle"
        return
      }

      // after the entitlement end we give 30 days to self destruct
      const selfDestructAt = periodEndAt + MAX_EVENT_AGE_MS

      if (now > selfDestructAt && remainingOutboxCount === 0) {
        wideEvent.self_destruct = true
        wideEvent.outcome = "deleted"
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
        return
      }

      // Pick the soonest among: outbox drain, time-based flush deadline,
      // self-destruct. Re-read the window because the time-flush above may
      // have just updated `lastFlushedAt`.
      const finalWindow = this.readWalletWindow(this.db)
      const candidates: number[] = []

      if (remainingOutboxCount > 0) {
        candidates.push(now + FLUSH_INTERVAL_MS)
      }

      if (finalWindow?.reservationId && !finalWindow.recoveryRequired) {
        const baseline = finalWindow.lastFlushedAt ?? now
        candidates.push(baseline + flushIntervalMs)
      }

      if (candidates.length === 0) {
        // Nothing pending — wake up at self-destruct time and die.
        wideEvent.next_alarm_at = selfDestructAt
        wideEvent.outcome = "scheduled"
        await this.scheduleAlarm(selfDestructAt)
        return
      }

      const target = Math.min(...candidates, selfDestructAt)
      // Never schedule in the past — at minimum wait one tick so we don't
      // hot-loop the alarm on a baseline that's already overdue.
      const scheduled = Math.max(now + 1_000, target)
      wideEvent.next_alarm_at = scheduled
      wideEvent.outcome = "scheduled"
      await this.scheduleAlarm(scheduled)
    } catch (error) {
      thrown = error
      throw error
    } finally {
      wideEvent.duration_ms = Date.now() - startTime
      if (thrown) {
        wideEvent.outcome = "error"
        wideEvent.error_type = thrown instanceof Error ? thrown.name : "unknown"
        wideEvent.error_message = thrown instanceof Error ? thrown.message : String(thrown)
      }
      this.logger.info("entitlement alarm", wideEvent)
    }
  }

  // Public RPC: mark this DO for teardown at the next alarm. We don't
  // delete immediately because there may be a live reservation holding
  // funds in `customer.{cid}.reserved` that must be captured + refunded
  // first. The alarm loop picks up `deletionRequested` on its next wake,
  // runs finalFlush, then calls `ctx.storage.deleteAll()`.
  public async requestDeletion(): Promise<void> {
    await this.ready
    this.db.update(meterWindowTable).set({ deletionRequested: true }).run()
    // Pull the alarm in: don't wait for the next natural FLUSH_INTERVAL_MS
    // tick if one isn't already imminent.
    await this.scheduleAlarm(Date.now())
  }

  // Slice 7.7 final flush: recognize the unflushed tail of consumed and
  // return any reserved remainder back to `available.purchased`. Runs
  // inside alarm() under the DO's single-threaded guarantee, so no
  // in-flight guard is needed — but we still bump `flushSeq` and park
  // `pendingFlushSeq` so a DO evicted mid-call can replay the same
  // ledger idempotency key on wake (see the constructor's recovery
  // path). WalletService treats `flushAmount == 0` as "skip the
  // recognize leg", so a no-activity period end or a deletion without
  // any events is cheap — only the refund leg fires.
  private async finalFlush(
    window: NonNullable<ReturnType<typeof this.readWalletWindow>>
  ): Promise<void> {
    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "final_flush",
        waitUntil: (p) => this.ctx.waitUntil(p),
        baseFields: {
          reservation_id: window.reservationId,
          project_id: window.projectId,
          customer_id: window.customerId,
          currency: window.currency,
          period_end_at: window.periodEndAt,
        },
      },
      async () => this.finalFlushInner(window)
    )
  }

  private async finalFlushInner(
    window: NonNullable<ReturnType<typeof this.readWalletWindow>>
  ): Promise<void> {
    const startTime = Date.now()
    const wideEvent: Record<string, unknown> = {
      operation: "final_flush",
      reservation_id: window.reservationId,
      project_id: window.projectId,
      customer_id: window.customerId,
      currency: window.currency,
      period_end_at: window.periodEndAt,
    }

    try {
      if (!window.reservationId || !window.projectId || !window.customerId) {
        this.logger.error("final flush requested without a reservation", {
          reservationId: window.reservationId,
          projectId: window.projectId,
          customerId: window.customerId,
        })
        wideEvent.outcome = "no_reservation"
        return
      }

      const unflushed = Math.max(0, window.consumedAmount - window.flushedAmount)
      const nextSeq = window.flushSeq + 1
      wideEvent.flush_seq = nextSeq
      wideEvent.flush_amount = unflushed

      this.db.update(meterWindowTable).set({ pendingFlushSeq: nextSeq }).run()

      const walletService = this.getWalletService()
      const result = await walletService.flushReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: nextSeq,
        flushAmount: unflushed,
        refillChunkAmount: 0,
        statementKey: `${window.reservationId}:${window.periodEndAt ?? 0}`,
        final: true,
        sourceId: this.ctx.id.toString(),
      })

      if (result.err) {
        this.logger.error(result.err, {
          context: "final flush failed",
          flushSeq: nextSeq,
          reservationId: window.reservationId,
        })
        // Leave pendingFlushSeq set so the next alarm tick (or a DO
        // restart) retries with the same seq — the ledger idempotency
        // key keeps replays safe.
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = result.err.message
        return
      }

      // Reservation closed. Clear the id so future apply()s on this DO
      // skip the wallet check until activateEntitlement opens a new one,
      // and roll the flush bookkeeping forward. We don't zero
      // consumed/allocation: they're historical totals and a reconciler
      // reading SQLite shouldn't lose them.
      this.db
        .update(meterWindowTable)
        .set({
          reservationId: null,
          flushedAmount: window.flushedAmount + result.val.flushedAmount,
          flushSeq: nextSeq,
          pendingFlushSeq: null,
          refillInFlight: false,
          lastFlushedAt: Date.now(),
        })
        .run()

      wideEvent.flushed_amount = result.val.flushedAmount
      wideEvent.flushed_after = window.flushedAmount + result.val.flushedAmount
      wideEvent.outcome = "success"
    } catch (error) {
      this.logger.error(error, {
        context: "final flush threw unexpectedly",
        flushSeq: window.flushSeq + 1,
        reservationId: window.reservationId,
      })
      wideEvent.outcome = "exception"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
    } finally {
      wideEvent.duration_ms = Date.now() - startTime
      this.logger.info("entitlement final_flush", wideEvent)
    }
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
    lastEventAt: number | null
    lastFlushedAt: number | null
    deletionRequested: boolean
    recoveryRequired: boolean
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
        lastEventAt: meterWindowTable.lastEventAt,
        lastFlushedAt: meterWindowTable.lastFlushedAt,
        deletionRequested: meterWindowTable.deletionRequested,
        recoveryRequired: meterWindowTable.recoveryRequired,
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
      lastEventAt: row.lastEventAt ?? null,
      lastFlushedAt: row.lastFlushedAt ?? null,
      deletionRequested: Boolean(row.deletionRequested),
      recoveryRequired: Boolean(row.recoveryRequired),
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
    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "flush_refill",
        waitUntil: (p) => this.ctx.waitUntil(p),
        baseFields: {
          flush_seq: trigger.flushSeq,
          flush_amount: trigger.flushAmount,
          refill_chunk_amount: trigger.refillChunkAmount,
        },
      },
      async () => this.requestFlushAndRefillInner(trigger)
    )
  }

  private async requestFlushAndRefillInner(trigger: RefillTrigger): Promise<void> {
    const startTime = Date.now()
    const window = this.readWalletWindow(this.db)

    const wideEvent: Record<string, unknown> = {
      operation: "flush_refill",
      flush_seq: trigger.flushSeq,
      flush_amount: trigger.flushAmount,
      refill_chunk_amount: trigger.refillChunkAmount,
      reservation_id: window?.reservationId ?? null,
      project_id: window?.projectId ?? null,
      customer_id: window?.customerId ?? null,
      currency: window?.currency ?? null,
      allocation_before: window?.allocationAmount ?? null,
      consumed_before: window?.consumedAmount ?? null,
      flushed_before: window?.flushedAmount ?? null,
    }

    try {
      if (!window?.reservationId || !window.projectId || !window.customerId) {
        this.logger.error("flush+refill requested without a reservation", {
          flushSeq: trigger.flushSeq,
          flushAmount: trigger.flushAmount,
          refillChunkAmount: trigger.refillChunkAmount,
        })
        this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "no_reservation"
        return
      }

      const walletService = this.getWalletService()
      const result = await walletService.flushReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: trigger.flushSeq,
        flushAmount: trigger.flushAmount,
        refillChunkAmount: trigger.refillChunkAmount,
        statementKey: `${window.reservationId}:${window.periodEndAt ?? 0}`,
        final: false,
        sourceId: this.ctx.id.toString(),
      })

      if (result.err) {
        this.logger.error(result.err, {
          context: "flush+refill failed",
          flushSeq: trigger.flushSeq,
          reservationId: window.reservationId,
        })
        // Clear the single-flight flag so apply() can re-trigger on the
        // next event; leave pendingFlushSeq set so crash recovery picks up
        // the same seq after an eviction.
        this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = result.err.message
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
          lastFlushedAt: Date.now(),
        })
        .run()

      wideEvent.granted_amount = result.val.grantedAmount
      wideEvent.flushed_amount = result.val.flushedAmount
      wideEvent.allocation_after = window.allocationAmount + result.val.grantedAmount
      wideEvent.flushed_after = window.flushedAmount + result.val.flushedAmount
      wideEvent.outcome = "success"
    } catch (error) {
      this.logger.error(error, {
        context: "flush+refill threw unexpectedly",
        flushSeq: trigger.flushSeq,
      })
      this.db.update(meterWindowTable).set({ refillInFlight: false }).run()
      wideEvent.outcome = "exception"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
    } finally {
      wideEvent.duration_ms = Date.now() - startTime
      this.logger.info("entitlement flush_refill", wideEvent)
    }
  }

  // Looks up a previously committed idempotency result for this event id.
  // Used to short-circuit retries before any wallet I/O — the in-tx check
  // in apply() catches concurrent retries that race past this read.
  private lookupCachedIdempotencyResult(eventId: string): ApplyResult | null {
    const row = this.db
      .select({
        allowed: idempotencyKeysTable.allowed,
        deniedReason: idempotencyKeysTable.deniedReason,
        denyMessage: idempotencyKeysTable.denyMessage,
      })
      .from(idempotencyKeysTable)
      .where(eq(idempotencyKeysTable.eventId, eventId))
      .get()

    if (!row) return null

    return {
      allowed: row.allowed,
      deniedReason:
        (row.deniedReason as ApplyResult["deniedReason"] | null | undefined) ?? undefined,
      message: row.denyMessage ?? undefined,
    }
  }

  // Phase 7.13 — opens the per-(stream, period) reservation lazily on first
  // priced apply(). Returns a denial result when the wallet has no available
  // balance to back the reservation; returns `null` on success (or when the
  // feature is free, in which case no reservation is needed).
  //
  // The reservation row is durable: even an allocation of 0 is persisted so
  // subsequent events on this DO short-circuit through the in-tx
  // LocalReservation check (which denies because allocation==0). The DO
  // doesn't re-attempt to grow allocation mid-period — that's what the
  // refill flush path is for, and refill only triggers from positive usage.
  // Customers who want service after running the wallet to 0 must wait for
  // the next period or top up (which clears `purchased` and the next
  // bootstrap on the next period picks it up).
  private async bootstrapReservation(input: ApplyInput): Promise<ApplyResult | null> {
    const pricePerEvent = this.computeMarginalPriceMinor(input.priceConfig)

    // The next event lands in a free portion of the curve — flat-free plan,
    // included-quantity tier still has runway, etc. No wallet engagement
    // needed for this event; a later apply() that crosses into a paid tier
    // will re-probe and bootstrap then.
    if (pricePerEvent <= 0) return null

    const sizing = sizeReservation(pricePerEvent)
    const walletService = this.getWalletService()

    const result = await walletService.createReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency as Currency,
      entitlementId: input.featurePlanVersionId,
      requestedAmount: sizing.requestedAmount,
      refillThresholdBps: sizing.refillThresholdBps,
      refillChunkAmount: sizing.refillChunkAmount,
      periodStartAt: new Date(input.periodStartAt),
      periodEndAt: new Date(input.periodEndAt),
      // The (project, entitlement, period_start) unique index is the real
      // dedupe — this key just tags ledger entries for traceability.
      idempotencyKey: `do_lazy:${input.streamId}:${input.periodStartAt}`,
    })

    if (result.err) {
      this.logger.error(this.errorMessage(result.err), {
        context: "lazy reservation bootstrap failed",
        customerId: input.customerId,
        projectId: input.projectId,
        streamId: input.streamId,
        entitlementId: input.featurePlanVersionId,
      })
      return {
        allowed: false,
        deniedReason: "WALLET_EMPTY",
        message: result.err.message,
      }
    }

    const meterKey = deriveMeterKey(input.meter)

    // Insert-or-update the meter window with the new reservation. The window
    // may not exist yet (first apply() in this DO's lifetime) — ensure it
    // first, then write the reservation columns.
    this.ensureMeterWindow(this.db, {
      meterKey,
      projectId: input.projectId,
      customerId: input.customerId,
      priceConfig: input.priceConfig,
      currency: input.currency,
      periodEndAt: input.periodEndAt,
      createdAt: Date.now(),
    })

    // For a reused active reservation, only refresh the columns that
    // concern wallet enforcement; preserve consumedAmount/flushedAmount/
    // flushSeq because the existing flush bookkeeping is still in flight.
    // For a fresh reservation, reset the bookkeeping to zero.
    const reservationUpdate =
      result.val.reused === "active"
        ? {
            reservationId: result.val.reservationId,
            allocationAmount: result.val.allocationAmount,
            refillThresholdBps: sizing.refillThresholdBps,
            refillChunkAmount: sizing.refillChunkAmount,
          }
        : {
            reservationId: result.val.reservationId,
            allocationAmount: result.val.allocationAmount,
            consumedAmount: 0,
            flushedAmount: 0,
            flushSeq: 0,
            pendingFlushSeq: null,
            refillThresholdBps: sizing.refillThresholdBps,
            refillChunkAmount: sizing.refillChunkAmount,
            refillInFlight: false,
          }

    this.db.update(meterWindowTable).set(reservationUpdate).run()

    if (result.val.allocationAmount <= 0) {
      // Wallet had no available funds — the reservation row exists with
      // allocation=0 so future events on this DO go through the standard
      // in-tx WALLET_EMPTY denial path. Surface the denial for this event
      // too so the caller doesn't think a free apply happened.
      return {
        allowed: false,
        deniedReason: "WALLET_EMPTY",
        message: "Wallet has no available balance to back the reservation",
      }
    }

    return null
  }

  // Worst-case per-event price at scale-8, used to size the lazy
  // reservation. Probes the local marginal at `currentUsage → currentUsage+1`
  // and *also* at every tier boundary in the price config. The boundary
  // probe matters because crossing into a tier with a `flatPrice` produces a
  // single-event jump that's invisible to a steady-state probe within either
  // tier — e.g. a config with `tier 1: 1-30 @ $0` and `tier 2: 31+ @ $1
  // flat + $0.001/unit` shows marginal = $0.001 if you only probe inside
  // tier 2, but the actual cost of the event taking usage 30→31 is $1.001.
  // Sizing by the local marginal alone produces a $1 reservation that the
  // first paid event blows past with WALLET_EMPTY.
  //
  // Returning 0 means "no event on this curve can ever cost anything" — the
  // bootstrap legitimately skips and the wallet never engages.
  private computeMarginalPriceMinor(priceConfig: ConfigFeatureVersionType): number {
    const currentUsage = Math.max(0, this.cache?.usage ?? 0)

    let maxMarginal = this.probeMarginal(priceConfig, currentUsage, currentUsage + 1)

    // Walk every tier's `firstUnit` boundary. This catches both the boundary
    // we're about to cross *and* boundaries further up the curve, so the
    // reservation we open now stays sized correctly across future crossings
    // without re-bootstrapping.
    const tiers = "tiers" in priceConfig ? priceConfig.tiers : undefined
    if (Array.isArray(tiers)) {
      for (const tier of tiers) {
        const firstUnit = tier?.firstUnit
        if (typeof firstUnit !== "number" || firstUnit < 1) continue
        const crossing = this.probeMarginal(priceConfig, firstUnit - 1, firstUnit)
        if (crossing > maxMarginal) maxMarginal = crossing
      }
    }

    return maxMarginal
  }

  private probeMarginal(
    priceConfig: ConfigFeatureVersionType,
    before: number,
    after: number
  ): number {
    try {
      const beforeResult = calculatePricePerFeature({
        quantity: before,
        featureType: DO_FEATURE_TYPE,
        config: priceConfig,
      })
      if (beforeResult.err) return 0

      const afterResult = calculatePricePerFeature({
        quantity: after,
        featureType: DO_FEATURE_TYPE,
        config: priceConfig,
      })
      if (afterResult.err) return 0

      return diffLedgerMinor(afterResult.val.totalPrice.dinero, beforeResult.val.totalPrice.dinero)
    } catch {
      return 0
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
      this.logger.error(error, {
        context: "Failed to parse entitlement meter fact outbox payload",
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
      this.logger.error(error, {
        context: "Failed to ingest entitlement meter facts to Tinybird",
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
