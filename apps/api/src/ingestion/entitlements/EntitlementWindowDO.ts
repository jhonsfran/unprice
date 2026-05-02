import { DurableObject } from "cloudflare:workers"
import {
  Analytics,
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import {
  type ConfigFeatureVersionType,
  type Currency,
  type OverageStrategy,
  type ResetConfig,
  configFeatureSchema,
  meterConfigSchema,
} from "@unprice/db/validators"
import { LEDGER_SCALE } from "@unprice/money"
import type { AppLogger } from "@unprice/observability"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  type GrantConsumptionState,
  MAX_EVENT_AGE_MS,
  type MeterConfig,
  computeGrantPeriodBucket,
  computeMaxMarginalPriceMinor,
  computeUsagePriceDeltaMinor,
  consumeGrantsByPriority,
  deriveMeterKey,
  resolveActiveGrants,
  resolveAvailableGrantUnits,
  resolveConsumedGrantUnits,
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
import {
  entitlementConfigTable,
  grantWindowsTable,
  grantsTable,
  idempotencyKeysTable,
  meterFactsOutboxTable,
  meterStateTable,
  schema,
  walletReservationTable,
} from "./db/schema"
import { DrizzleStorageAdapter } from "./drizzle-adapter"
import migrations from "./drizzle/migrations"

class EntitlementWindowLimitExceededError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      available: number
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
  customer_entitlement_id: z.string(),
  grant_id: z.string().optional(),
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

const resetConfigSnapshotSchema = z.custom<ResetConfig>(
  (val) => val != null && typeof val === "object"
)

const activeGrantSchema = z.object({
  allowanceUnits: z.number().finite().nullable(),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  grantId: z.string().min(1),
  priority: z.number().int(),
})

const entitlementConfigSchema = z.object({
  allowanceUnits: z.number().finite().nullable(),
  customerEntitlementId: z.string().min(1),
  customerId: z.string().min(1),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  featureConfig: configFeatureSchema,
  featurePlanVersionId: z.string().min(1),
  featureSlug: z.string().min(1),
  featureType: z.string().min(1),
  meterConfig: meterConfigSchema,
  overageStrategy: overageStrategySchema,
  projectId: z.string().min(1),
  resetConfig: resetConfigSnapshotSchema.nullable().optional(),
})

const applyInputSchema = z.object({
  event: rawEventSchema,
  idempotencyKey: z.string().min(1),
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema).min(1),
  enforceLimit: z.boolean(),
  now: z.number(),
})

const enforcementStateInputSchema = z.object({
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema),
  now: z.number().finite(),
})

type ApplyInput = z.infer<typeof applyInputSchema>
type ApplyGrantInput = z.infer<typeof activeGrantSchema>
type EnforcementStateInput = z.infer<typeof enforcementStateInputSchema>
type ActiveGrantInput = ApplyGrantInput & {
  cadenceEffectiveAt: number
  cadenceExpiresAt: number | null
  currencyCode: string
  resetConfig: ResetConfig | null
}
type EntitlementConfigInput = z.infer<typeof entitlementConfigSchema>

type MeterIdentity = {
  customerEntitlementId: string
  currency: string
  key: string
  config: MeterConfig
}

type PricedFact = {
  amountMinor: number
  currency: string
  fact: Fact
  featurePlanVersionId: string
  featureSlug: string
  grantId?: string
  periodKey: string
  usageAfter: number
  usageBefore: number
  units: number
}

const FLUSH_BATCH_SIZE = 1000
const FLUSH_INTERVAL_MS = 30_000
const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 5000
const OUTBOX_DEPTH_ALERT_THRESHOLD = 1000
const WALLET_RESERVATION_ROW_ID = "singleton"
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

function minNullableExpiry(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

export class EntitlementWindowDO extends DurableObject {
  private readonly analytics: Analytics
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly logger: AppLogger
  private readonly ready: Promise<void>
  private readonly runtimeEnv: Env
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

      // Crash recovery (Phase 7.5). If the DO was evicted mid-flush, the
      // SQLite row still carries `pending_flush_seq > flush_seq`. Re-issue
      // the flush with the same seq — WalletService dedupes via the ledger
      // idempotency key `flush:{reservationId}:{flushSeq}`, so a duplicate
      // call after a successful commit is a no-op. `flushAmount` is
      // re-derived from `consumed - flushed` because we don't persist the
      // pending flush amount separately; any events accepted after the
      // failed flush are folded into the retry, which is correct.
      const window = this.readWalletReservation(this.db)
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

    const activeGrants = this.db.transaction((tx) => {
      this.syncEntitlementConfig(tx, {
        entitlement: input.entitlement,
        createdAt,
      })
      this.syncGrants(tx, {
        customerEntitlementId: input.entitlement.customerEntitlementId,
        grants: input.grants,
        createdAt,
      })
      return resolveActiveGrants(this.readGrants(tx), input.event.timestamp)
    })

    if (activeGrants.length === 0) {
      // Ingestion resolves active grants before calling this DO. If the local
      // replay yields none, the payload is inconsistent and should fail loudly
      // instead of being cached as a business denial.
      throw new Error("No active grants found for event timestamp")
    }

    const entitlement = this.readEntitlementConfig(this.db)
    if (!entitlement) {
      throw new Error("No entitlement config found after sync")
    }

    const meter = this.resolveMeterIdentity(entitlement)
    const overageStrategy = entitlement.overageStrategy

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
      customer_entitlement_id: entitlement.customerEntitlementId,
      grant_count: activeGrants.length,
      synced_grant_count: input.grants.length,
      meter_key: meter.key,
      aggregation_method: meter.config.aggregationMethod,
      enforce_limit: input.enforceLimit,
    }

    let result: ApplyResult | undefined
    let thrown: unknown
    let insertedFactCount = 0
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
      const preWindow = this.readWalletReservation(this.db)
      const needsBootstrap = !preWindow || preWindow.reservationId === null
      wideEvent.bootstrap_attempted = needsBootstrap

      if (needsBootstrap) {
        const denial = await this.bootstrapReservation(input, activeGrants, meter)
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
        wideEvent.bootstrap_outcome = "reservation_already_open"
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

          // Ensure the raw meter-state row exists before the engine adapter
          // updates its usage/updatedAt columns. This usage is not entitlement
          // usage; grant_windows owns entitlement-period consumption.
          this.ensureMeterState(tx, {
            meterKey: meter.key,
            createdAt,
          })

          const adapter = new DrizzleStorageAdapter(tx)
          // The engine persists only raw aggregation state through its adapter.
          // Entitlement usage is written below into grant_windows by grant bucket.
          const engine = new AsyncMeterAggregationEngine([meter.config], adapter, input.now)

          const facts = engine.applyEventSync(input.event, {
            // A limit hit is still a valid ingestion event. We store the denied
            // result in the DO idempotency table so queue retries stay stable,
            // while the ingestion service treats the event as processed.
            beforePersist: (pendingFacts) => {
              if (!input.enforceLimit) {
                return
              }

              const exceeded = this.findGrantLimitExceededFact({
                activeGrants,
                facts: pendingFacts,
                overageStrategy,
                states: this.readGrantStates(tx),
                entitlement,
                timestamp: input.event.timestamp,
              })

              if (exceeded) {
                throw new EntitlementWindowLimitExceededError({
                  available: resolveAvailableGrantUnits({
                    grants: activeGrants,
                    states: this.readGrantStates(tx),
                    timestamp: input.event.timestamp,
                  }),
                  eventId: input.event.id,
                  meterKey: exceeded.meterKey,
                })
              }
            },
          })

          insertedFactCount = facts.length

          const pricedFacts = this.priceFactsFromGrantWindows(tx, {
            activeGrants,
            entitlement,
            eventTimestamp: input.event.timestamp,
            facts,
          })

          // Phase 7 wallet check. Only engages when a reservation has been
          // opened on this window (activation path, slice 7.12). Without a
          // reservation the DO operates in the pre-wallet behaviour: no
          // allocation tracking, no refill trigger.
          const window = this.readWalletReservation(tx)
          if (window?.reservationId && pricedFacts.length > 0) {
            reservationEngaged = true
            // Pricing has already run through Dinero and was normalized into
            // ledger-scale integers. Mixed currencies are rejected at grant sync.
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
                meterKey: meter.key,
                reservationId: window.reservationId,
                cost: totalCost,
                remaining: window.allocationAmount - window.consumedAmount,
              })
            }

            // Synchronous SQLite write before any post-commit action. On
            // replay the idempotency row short-circuits above, so this only
            // runs on the first-success path.
            tx.update(walletReservationTable)
              .set({ consumedAmount: walletResult.newState.consumedAmount })
              .run()

            if (walletResult.needsRefill && !window.refillInFlight) {
              const nextSeq = window.flushSeq + 1

              tx.update(walletReservationTable)
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

          for (const pricedFact of pricedFacts) {
            const payload = this.buildOutboxFactPayload({
              createdAt,
              input,
              meter,
              pricedFact,
            })

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
          tx.update(walletReservationTable).set({ lastEventAt: createdAt }).run()

          return { allowed: true } as ApplyResult
        })

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
          // Keep reservation growth in the async refill path. Re-opening or
          // synchronously growing a reservation here would make a denied retry
          // depend on live wallet state instead of the idempotency table.
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

  public async getEnforcementState(rawInput?: EnforcementStateInput): Promise<{
    isLimitReached: boolean
    limit: number | null
    usage: number
  }> {
    await this.ready

    const input = rawInput ? enforcementStateInputSchema.parse(rawInput) : null
    const timestamp = input?.now ?? Date.now()
    const syncedAt = Date.now()
    const activeGrants = this.db.transaction((tx) => {
      if (input) {
        this.syncEntitlementConfig(tx, {
          entitlement: input.entitlement,
          createdAt: syncedAt,
        })
        this.syncGrants(tx, {
          customerEntitlementId: input.entitlement.customerEntitlementId,
          grants: input.grants,
          createdAt: syncedAt,
        })
      }

      return resolveActiveGrants(this.readGrants(tx), timestamp)
    })
    const entitlement = this.readEntitlementConfig(this.db)

    if (!entitlement || activeGrants.length === 0) {
      return { usage: 0, limit: null, isLimitReached: false }
    }

    const states = this.readGrantStates(this.db)
    const usage = resolveConsumedGrantUnits({
      grants: activeGrants,
      states,
      timestamp,
    })
    const limit = this.resolveTotalGrantUnits(activeGrants)
    const overageStrategy = entitlement.overageStrategy
    const available = resolveAvailableGrantUnits({
      grants: activeGrants,
      states,
      timestamp,
    })

    return {
      usage,
      limit,
      isLimitReached:
        overageStrategy !== "always" &&
        limit !== null &&
        Number.isFinite(available) &&
        available <= 0,
    }
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
      const window = this.readWalletReservation(this.db)
      const now = Date.now()

      wideEvent.reservation_id = window?.reservationId ?? null
      wideEvent.recovery_required = window?.recoveryRequired ?? false

      if (window?.reservationId && !window.recoveryRequired) {
        const isPeriodEnd = window.reservationEndAt !== null && now >= window.reservationEndAt
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
      // waiting for the refill threshold or reservation end.
      //
      // Re-read the window because finalFlush above may have closed it.
      // `refillInFlight` guards against a concurrent apply()-triggered refill
      // (single-threaded per DO, but the apply path's `ctx.waitUntil` can
      // outlive the request and we don't want the alarm to race it).
      const flushIntervalMs = maxFlushIntervalMs(this.runtimeEnv)
      const postFlushWindow = this.readWalletReservation(this.db)
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
            .update(walletReservationTable)
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

      const lifecycleEndAt = this.readLifecycleEndAt()
      wideEvent.lifecycle_end_at = lifecycleEndAt

      if (!lifecycleEndAt) {
        // We don't know when this DO can be safely collected, and outbox is empty.
        // Go to sleep. Next apply() will wake us up.
        wideEvent.outcome = "idle"
        return
      }

      // After the latest known grant/reservation window we give 30 days to self destruct.
      const selfDestructAt = lifecycleEndAt + MAX_EVENT_AGE_MS

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
      const finalWindow = this.readWalletReservation(this.db)
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
    this.db.update(walletReservationTable).set({ deletionRequested: true }).run()
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
    window: NonNullable<ReturnType<typeof this.readWalletReservation>>
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
          reservation_end_at: window.reservationEndAt,
        },
      },
      async () => this.finalFlushInner(window)
    )
  }

  private async finalFlushInner(
    window: NonNullable<ReturnType<typeof this.readWalletReservation>>
  ): Promise<void> {
    const startTime = Date.now()
    const wideEvent: Record<string, unknown> = {
      operation: "final_flush",
      reservation_id: window.reservationId,
      project_id: window.projectId,
      customer_id: window.customerId,
      currency: window.currency,
      reservation_end_at: window.reservationEndAt,
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

      this.db.update(walletReservationTable).set({ pendingFlushSeq: nextSeq }).run()

      const walletService = this.getWalletService()
      const result = await walletService.flushReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: nextSeq,
        flushAmount: unflushed,
        refillChunkAmount: 0,
        statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
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
        .update(walletReservationTable)
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

  private ensureMeterState(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      meterKey: string
      createdAt: number
    }
  ): void {
    tx.insert(meterStateTable)
      .values({
        meterKey: params.meterKey,
        usage: 0,
        updatedAt: null,
        createdAt: params.createdAt,
      })
      .onConflictDoNothing({ target: meterStateTable.meterKey })
      .run()
  }

  private ensureWalletReservation(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      projectId: string
      customerId: string
      currency: string
      reservationEndAt: number
    }
  ): void {
    tx.insert(walletReservationTable)
      .values({
        id: WALLET_RESERVATION_ROW_ID,
        projectId: params.projectId,
        customerId: params.customerId,
        currency: params.currency,
        reservationEndAt: params.reservationEndAt,
      })
      .onConflictDoNothing({ target: walletReservationTable.id })
      .run()

    tx.update(walletReservationTable)
      .set({
        projectId: params.projectId,
        customerId: params.customerId,
        currency: params.currency,
        reservationEndAt: params.reservationEndAt,
      })
      .run()
  }

  private resolveMeterIdentity(entitlement: EntitlementConfigInput): MeterIdentity {
    return {
      customerEntitlementId: entitlement.customerEntitlementId,
      currency: this.extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
      key: deriveMeterKey(entitlement.meterConfig),
      config: entitlement.meterConfig,
    }
  }

  private extractCurrencyCodeFromFeatureConfig(config: unknown): string | null {
    const currencyFromPrice = this.extractCurrencyCode(config, "price")
    if (currencyFromPrice) {
      return currencyFromPrice
    }

    if (!this.isRecord(config) || !Array.isArray(config.tiers)) {
      return null
    }

    for (const tier of config.tiers) {
      const currencyFromTier = this.extractCurrencyCode(tier, "unitPrice")
      if (currencyFromTier) {
        return currencyFromTier
      }
    }

    return null
  }

  private extractCurrencyCode(input: unknown, priceKey: string): string | null {
    if (!this.isRecord(input)) {
      return null
    }

    const price = input[priceKey]
    if (!this.isRecord(price)) {
      return null
    }

    const dinero = price.dinero
    if (!this.isRecord(dinero)) {
      return null
    }

    const currency = dinero.currency
    if (!this.isRecord(currency)) {
      return null
    }

    const code = currency.code
    return typeof code === "string" && code.length > 0 ? code : null
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  private resolveTotalGrantUnits(grants: ActiveGrantInput[]): number | null {
    if (grants.some((grant) => grant.allowanceUnits === null)) {
      return null
    }

    return grants.reduce((total, grant) => total + (grant.allowanceUnits ?? 0), 0)
  }

  private findGrantLimitExceededFact(params: {
    activeGrants: ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    facts: Fact[]
    overageStrategy: OverageStrategy
    states: GrantConsumptionState[]
    timestamp: number
  }): Fact | null {
    if (params.overageStrategy === "always") {
      return null
    }

    let available = resolveAvailableGrantUnits({
      grants: params.activeGrants,
      states: params.states,
      timestamp: params.timestamp,
    })

    if (available === Number.POSITIVE_INFINITY) {
      return null
    }

    for (const fact of params.facts) {
      if (fact.delta <= 0) {
        continue
      }

      if (params.overageStrategy === "last-call") {
        if (available <= 0) return fact
        available = Math.max(0, available - fact.delta)
        continue
      }

      if (fact.delta > available) {
        return fact
      }

      available -= fact.delta
    }

    return null
  }

  private syncEntitlementConfig(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      createdAt: number
      entitlement: EntitlementConfigInput
    }
  ): void {
    const existing = tx
      .select({
        customerEntitlementId: entitlementConfigTable.customerEntitlementId,
        projectId: entitlementConfigTable.projectId,
        customerId: entitlementConfigTable.customerId,
        effectiveAt: entitlementConfigTable.effectiveAt,
        expiresAt: entitlementConfigTable.expiresAt,
        featureConfig: entitlementConfigTable.featureConfig,
        featurePlanVersionId: entitlementConfigTable.featurePlanVersionId,
        featureSlug: entitlementConfigTable.featureSlug,
        meterConfig: entitlementConfigTable.meterConfig,
        overageStrategy: entitlementConfigTable.overageStrategy,
        resetConfig: entitlementConfigTable.resetConfig,
      })
      .from(entitlementConfigTable)
      .where(
        eq(entitlementConfigTable.customerEntitlementId, params.entitlement.customerEntitlementId)
      )
      .get()

    const values = {
      customerEntitlementId: params.entitlement.customerEntitlementId,
      projectId: params.entitlement.projectId,
      customerId: params.entitlement.customerId,
      effectiveAt: params.entitlement.effectiveAt,
      expiresAt: params.entitlement.expiresAt,
      featureConfig: params.entitlement.featureConfig,
      featurePlanVersionId: params.entitlement.featurePlanVersionId,
      featureSlug: params.entitlement.featureSlug,
      meterConfig: params.entitlement.meterConfig,
      overageStrategy: params.entitlement.overageStrategy,
      resetConfig: params.entitlement.resetConfig ?? null,
      updatedAt: params.createdAt,
    }

    if (existing) {
      this.assertImmutableEntitlementConfig(existing, params.entitlement)

      const nextExpiresAt = minNullableExpiry(existing.expiresAt ?? null, values.expiresAt)
      if (nextExpiresAt !== (existing.expiresAt ?? null)) {
        tx.update(entitlementConfigTable)
          .set({
            expiresAt: nextExpiresAt,
            updatedAt: params.createdAt,
          })
          .where(
            eq(
              entitlementConfigTable.customerEntitlementId,
              params.entitlement.customerEntitlementId
            )
          )
          .run()
      }
      return
    }

    tx.insert(entitlementConfigTable)
      .values({
        ...values,
        addedAt: params.createdAt,
      })
      .run()
  }

  private assertImmutableEntitlementConfig(
    existing: {
      customerEntitlementId: string
      projectId: string
      customerId: string
      effectiveAt: number
      featureConfig: ConfigFeatureVersionType
      featurePlanVersionId: string
      featureSlug: string
      meterConfig: MeterConfig
      overageStrategy: OverageStrategy
      resetConfig: ResetConfig | null
    },
    incoming: EntitlementConfigInput
  ): void {
    const mismatches: string[] = []

    if (existing.customerEntitlementId !== incoming.customerEntitlementId) {
      mismatches.push("customerEntitlementId")
    }
    if (existing.projectId !== incoming.projectId) mismatches.push("projectId")
    if (existing.customerId !== incoming.customerId) mismatches.push("customerId")
    if (existing.effectiveAt !== incoming.effectiveAt) mismatches.push("effectiveAt")
    if (existing.featurePlanVersionId !== incoming.featurePlanVersionId) {
      mismatches.push("featurePlanVersionId")
    }
    if (existing.featureSlug !== incoming.featureSlug) mismatches.push("featureSlug")
    if (existing.overageStrategy !== incoming.overageStrategy) mismatches.push("overageStrategy")
    if (!jsonEquals(existing.featureConfig, incoming.featureConfig)) {
      mismatches.push("featureConfig")
    }
    if (!jsonEquals(existing.meterConfig, incoming.meterConfig)) {
      mismatches.push("meterConfig")
    }
    if (!jsonEquals(existing.resetConfig ?? null, incoming.resetConfig ?? null)) {
      mismatches.push("resetConfig")
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Immutable entitlement config changed for ${incoming.customerEntitlementId}: ${mismatches.join(", ")}`
      )
    }
  }

  private readEntitlementConfig(
    tx: DrizzleSqliteDODatabase<typeof schema>
  ): EntitlementConfigInput | null {
    const row = tx
      .select({
        customerEntitlementId: entitlementConfigTable.customerEntitlementId,
        projectId: entitlementConfigTable.projectId,
        customerId: entitlementConfigTable.customerId,
        effectiveAt: entitlementConfigTable.effectiveAt,
        expiresAt: entitlementConfigTable.expiresAt,
        featureConfig: entitlementConfigTable.featureConfig,
        featurePlanVersionId: entitlementConfigTable.featurePlanVersionId,
        featureSlug: entitlementConfigTable.featureSlug,
        meterConfig: entitlementConfigTable.meterConfig,
        overageStrategy: entitlementConfigTable.overageStrategy,
        resetConfig: entitlementConfigTable.resetConfig,
      })
      .from(entitlementConfigTable)
      .get()

    if (!row) {
      return null
    }

    return {
      allowanceUnits: null,
      customerEntitlementId: row.customerEntitlementId,
      projectId: row.projectId,
      customerId: row.customerId,
      effectiveAt: row.effectiveAt,
      expiresAt: row.expiresAt ?? null,
      featureConfig: row.featureConfig,
      featurePlanVersionId: row.featurePlanVersionId,
      featureSlug: row.featureSlug,
      featureType: "usage",
      meterConfig: row.meterConfig,
      overageStrategy: row.overageStrategy,
      resetConfig: row.resetConfig ?? null,
    }
  }

  private syncGrants(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      customerEntitlementId: string
      createdAt: number
      grants: ApplyGrantInput[]
    }
  ): void {
    for (const grant of params.grants) {
      const existing = tx
        .select({
          grantId: grantsTable.grantId,
          expiresAt: grantsTable.expiresAt,
        })
        .from(grantsTable)
        .where(eq(grantsTable.grantId, grant.grantId))
        .get()

      if (existing) {
        const nextExpiresAt = minNullableExpiry(existing.expiresAt ?? null, grant.expiresAt)
        if (nextExpiresAt !== (existing.expiresAt ?? null)) {
          tx.update(grantsTable)
            .set({ expiresAt: nextExpiresAt })
            .where(eq(grantsTable.grantId, grant.grantId))
            .run()
        }
      } else {
        tx.insert(grantsTable)
          .values({
            grantId: grant.grantId,
            customerEntitlementId: params.customerEntitlementId,
            allowanceUnits: grant.allowanceUnits,
            effectiveAt: grant.effectiveAt,
            expiresAt: grant.expiresAt,
            priority: grant.priority,
            addedAt: params.createdAt,
          })
          .run()
      }
    }
  }

  private readGrants(tx: DrizzleSqliteDODatabase<typeof schema>): ActiveGrantInput[] {
    const entitlement = this.readEntitlementConfig(tx)
    if (!entitlement) {
      return []
    }

    return tx
      .select({
        grantId: grantsTable.grantId,
        allowanceUnits: grantsTable.allowanceUnits,
        effectiveAt: grantsTable.effectiveAt,
        expiresAt: grantsTable.expiresAt,
        priority: grantsTable.priority,
      })
      .from(grantsTable)
      .all()
      .map((row) => ({
        allowanceUnits: row.allowanceUnits ?? null,
        cadenceEffectiveAt: entitlement.effectiveAt,
        cadenceExpiresAt: entitlement.expiresAt,
        currencyCode: this.extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt ?? null,
        grantId: row.grantId,
        priority: row.priority,
        resetConfig: entitlement.resetConfig ?? null,
      }))
  }

  private readGrantStates(tx: DrizzleSqliteDODatabase<typeof schema>): GrantConsumptionState[] {
    return tx
      .select({
        bucketKey: grantWindowsTable.bucketKey,
        grantId: grantWindowsTable.grantId,
        periodKey: grantWindowsTable.periodKey,
        periodStartAt: grantWindowsTable.periodStartAt,
        periodEndAt: grantWindowsTable.periodEndAt,
        consumedInCurrentWindow: grantWindowsTable.consumedInCurrentWindow,
        exhaustedAt: grantWindowsTable.exhaustedAt,
      })
      .from(grantWindowsTable)
      .all()
  }

  private buildOutboxFactPayload(params: {
    createdAt: number
    input: ApplyInput
    meter: MeterIdentity
    pricedFact: PricedFact
  }): OutboxFact {
    const { createdAt, input, meter, pricedFact } = params
    const { fact } = pricedFact

    return {
      id: [
        meter.customerEntitlementId,
        pricedFact.periodKey,
        input.event.id,
        fact.meterKey,
        pricedFact.grantId ?? "legacy",
      ].join(":"),
      event_id: input.event.id,
      idempotency_key: input.idempotencyKey,
      project_id: input.projectId,
      customer_id: input.customerId,
      currency: pricedFact.currency,
      customer_entitlement_id: meter.customerEntitlementId,
      grant_id: pricedFact.grantId,
      feature_plan_version_id: pricedFact.featurePlanVersionId,
      feature_slug: pricedFact.featureSlug,
      period_key: pricedFact.periodKey,
      event_slug: input.event.slug,
      aggregation_method: meter.config.aggregationMethod,
      timestamp: input.event.timestamp,
      created_at: createdAt,
      delta: pricedFact.units,
      value_after: pricedFact.usageAfter,
      amount: pricedFact.amountMinor,
      amount_scale: LEDGER_SCALE,
      priced_at: createdAt,
    }
  }

  private priceFactsFromGrantWindows(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      activeGrants: ActiveGrantInput[]
      entitlement: EntitlementConfigInput
      eventTimestamp: number
      facts: Fact[]
    }
  ): PricedFact[] {
    const pricedFacts: PricedFact[] = []
    const priceGrant = this.firstGrantByDrainOrder(params.activeGrants)

    for (const fact of params.facts) {
      if (fact.delta <= 0) {
        pricedFacts.push(
          this.priceFactWithEntitlement({
            entitlement: params.entitlement,
            fact,
            grant: priceGrant,
            timestamp: params.eventTimestamp,
          })
        )
        continue
      }

      const consumed = consumeGrantsByPriority({
        grants: params.activeGrants,
        states: this.readGrantStates(tx),
        timestamp: params.eventTimestamp,
        units: fact.delta,
      })

      for (const allocation of consumed.allocations) {
        pricedFacts.push({
          amountMinor: computeUsagePriceDeltaMinor({
            priceConfig: params.entitlement.featureConfig,
            usageAfter: allocation.usageAfter,
            usageBefore: allocation.usageBefore,
          }),
          currency: allocation.grant.currencyCode,
          fact,
          featurePlanVersionId: params.entitlement.featurePlanVersionId,
          featureSlug: params.entitlement.featureSlug,
          grantId: allocation.grant.grantId,
          periodKey: allocation.periodKey,
          usageAfter: allocation.usageAfter,
          usageBefore: allocation.usageBefore,
          units: allocation.units,
        })

        this.writeGrantConsumption(tx, allocation.nextState)
      }

      if (consumed.remaining > 0) {
        pricedFacts.push(
          this.priceFactWithEntitlement({
            entitlement: params.entitlement,
            fact,
            grant: priceGrant,
            timestamp: params.eventTimestamp,
          })
        )
      }
    }

    return pricedFacts
  }

  private priceFactWithEntitlement(params: {
    entitlement: EntitlementConfigInput
    fact: Fact
    grant: ActiveGrantInput
    timestamp: number
  }): PricedFact {
    const { entitlement, fact, grant, timestamp } = params
    const bucket = computeGrantPeriodBucket(grant, timestamp)
    if (!bucket) {
      throw new Error("Unable to resolve grant bucket for fact pricing")
    }

    const usageAfter = Math.max(0, fact.valueAfter)
    const usageBefore = Math.max(0, fact.valueAfter - fact.delta)

    return {
      amountMinor: computeUsagePriceDeltaMinor({
        priceConfig: entitlement.featureConfig,
        usageAfter,
        usageBefore,
      }),
      currency: grant.currencyCode,
      fact,
      featurePlanVersionId: entitlement.featurePlanVersionId,
      featureSlug: entitlement.featureSlug,
      grantId: grant.grantId,
      periodKey: bucket.periodKey,
      usageAfter,
      usageBefore,
      units: fact.delta,
    }
  }

  private writeGrantConsumption(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    state: GrantConsumptionState
  ): void {
    const existing = tx
      .select({ bucketKey: grantWindowsTable.bucketKey })
      .from(grantWindowsTable)
      .where(eq(grantWindowsTable.bucketKey, state.bucketKey))
      .get()

    if (existing) {
      tx.update(grantWindowsTable)
        .set({
          consumedInCurrentWindow: state.consumedInCurrentWindow,
          exhaustedAt: state.exhaustedAt,
        })
        .where(eq(grantWindowsTable.bucketKey, state.bucketKey))
        .run()
      return
    }

    tx.insert(grantWindowsTable)
      .values({
        bucketKey: state.bucketKey,
        grantId: state.grantId,
        periodKey: state.periodKey,
        periodStartAt: state.periodStartAt,
        periodEndAt: state.periodEndAt,
        consumedInCurrentWindow: state.consumedInCurrentWindow,
        exhaustedAt: state.exhaustedAt,
      })
      .run()
  }

  private firstGrantByDrainOrder(grants: ActiveGrantInput[]): ActiveGrantInput {
    const grant = [...grants].sort((left, right) => this.compareGrantDrainOrder(left, right))[0]
    if (!grant) {
      throw new Error("Expected at least one grant")
    }
    return grant
  }

  private compareGrantDrainOrder(
    left: Pick<ActiveGrantInput, "expiresAt" | "grantId" | "priority">,
    right: Pick<ActiveGrantInput, "expiresAt" | "grantId" | "priority">
  ): number {
    return (
      right.priority - left.priority ||
      (left.expiresAt ?? Number.POSITIVE_INFINITY) -
        (right.expiresAt ?? Number.POSITIVE_INFINITY) ||
      left.grantId.localeCompare(right.grantId)
    )
  }

  private readLifecycleEndAt(): number | null {
    const grantWindowEnds = this.db
      .select({ periodEndAt: grantWindowsTable.periodEndAt })
      .from(grantWindowsTable)
      .all()
      .map((row) => row.periodEndAt)
      .filter((end): end is number => typeof end === "number" && Number.isFinite(end))

    const reservationEndAt = this.readWalletReservation(this.db)?.reservationEndAt
    if (typeof reservationEndAt === "number" && Number.isFinite(reservationEndAt)) {
      grantWindowEnds.push(reservationEndAt)
    }

    return grantWindowEnds.length > 0 ? Math.max(...grantWindowEnds) : null
  }

  // Read the reservation-relevant fields in one shot. Returns `null` when
  // no reservation row exists yet (pre-first-paid-apply). A row with a null
  // `reservationId` means the DO is operating without a reservation —
  // callers must treat that as "skip wallet check".
  private readWalletReservation(tx: DrizzleSqliteDODatabase<typeof schema>): {
    projectId: string | null
    customerId: string | null
    currency: string
    reservationEndAt: number | null
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
        projectId: walletReservationTable.projectId,
        customerId: walletReservationTable.customerId,
        currency: walletReservationTable.currency,
        reservationEndAt: walletReservationTable.reservationEndAt,
        reservationId: walletReservationTable.reservationId,
        allocationAmount: walletReservationTable.allocationAmount,
        consumedAmount: walletReservationTable.consumedAmount,
        flushedAmount: walletReservationTable.flushedAmount,
        refillThresholdBps: walletReservationTable.refillThresholdBps,
        refillChunkAmount: walletReservationTable.refillChunkAmount,
        refillInFlight: walletReservationTable.refillInFlight,
        flushSeq: walletReservationTable.flushSeq,
        pendingFlushSeq: walletReservationTable.pendingFlushSeq,
        lastEventAt: walletReservationTable.lastEventAt,
        lastFlushedAt: walletReservationTable.lastFlushedAt,
        deletionRequested: walletReservationTable.deletionRequested,
        recoveryRequired: walletReservationTable.recoveryRequired,
      })
      .from(walletReservationTable)
      .get()

    if (!row) return null

    return {
      projectId: row.projectId ?? null,
      customerId: row.customerId ?? null,
      currency: String(row.currency ?? ""),
      reservationEndAt: row.reservationEndAt ?? null,
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
    const window = this.readWalletReservation(this.db)

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
        this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
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
        statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
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
        this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = result.err.message
        return
      }

      this.db
        .update(walletReservationTable)
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
      this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
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
  private async bootstrapReservation(
    input: ApplyInput,
    activeGrants: ActiveGrantInput[],
    meter: MeterIdentity
  ): Promise<ApplyResult | null> {
    const pricePerEvent = computeMaxMarginalPriceMinor(input.entitlement.featureConfig)

    // The next event lands in a free portion of the curve — flat-free plan,
    // included-quantity tier still has runway, etc. No wallet engagement
    // needed for this event; a later apply() that crosses into a paid tier
    // will re-probe and bootstrap then.
    if (pricePerEvent <= 0) return null

    const sizing = sizeReservation(pricePerEvent)
    const walletService = this.getWalletService()
    const reservationGrant = this.firstGrantByDrainOrder(activeGrants)
    const reservationBucket = computeGrantPeriodBucket(reservationGrant, input.event.timestamp)

    if (!reservationBucket) {
      throw new Error("Unable to resolve grant bucket for reservation bootstrap")
    }

    const result = await walletService.createReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: meter.currency as Currency,
      entitlementId: input.entitlement.customerEntitlementId,
      requestedAmount: sizing.requestedAmount,
      refillThresholdBps: sizing.refillThresholdBps,
      refillChunkAmount: sizing.refillChunkAmount,
      periodStartAt: new Date(reservationBucket.start),
      periodEndAt: new Date(reservationBucket.end),
      // The (project, entitlement, period_start) unique index is the real
      // dedupe — this key just tags ledger entries for traceability.
      idempotencyKey: `do_lazy:${meter.customerEntitlementId}:${reservationBucket.periodKey}`,
    })

    if (result.err) {
      this.logger.error(this.errorMessage(result.err), {
        context: "lazy reservation bootstrap failed",
        customerId: input.customerId,
        projectId: input.projectId,
        customerEntitlementId: input.entitlement.customerEntitlementId,
      })
      return {
        allowed: false,
        deniedReason: "WALLET_EMPTY",
        message: result.err.message,
      }
    }

    this.ensureMeterState(this.db, {
      meterKey: meter.key,
      createdAt: Date.now(),
    })
    this.ensureWalletReservation(this.db, {
      projectId: input.projectId,
      customerId: input.customerId,
      currency: meter.currency,
      reservationEndAt: reservationBucket.end,
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

    this.db.update(walletReservationTable).set(reservationUpdate).run()

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

  private async scheduleAlarm(target: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null && existing <= target) return
    await this.ctx.storage.setAlarm(target)
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJson(left ?? null)) === JSON.stringify(stableJson(right ?? null))
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, stableJson(nestedValue)])
    )
  }

  return value
}
