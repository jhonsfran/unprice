import { DurableObject } from "cloudflare:workers"
import {
  Analytics,
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import {
  type ConfigFeatureVersionType,
  type CreditLinePolicy,
  type Currency,
  type OverageStrategy,
  type ResetConfig,
  configFeatureSchema,
  creditLinePolicySchema,
  meterConfigSchema,
} from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { LEDGER_SCALE } from "@unprice/money"
import {
  AsyncMeterAggregationEngine,
  DO_IDEMPOTENCY_TTL_MS,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  type GrantConsumptionState,
  LATE_EVENT_GRACE_MS,
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
import type { IngestionRejectionReason } from "@unprice/services/ingestion"
import { LedgerGateway } from "@unprice/services/ledger"
import { type ReservationCloseReason, WalletService } from "@unprice/services/wallet"
import {
  DEFAULT_RESERVATION_POLICY,
  type ReservationPolicy,
  computeEffectiveWalletCost,
  computeInitialReservation,
  computeRefillDecision,
  computeSyncGrowRefillAmount,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import { asc, eq, inArray, lt, lte } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import { z } from "zod"
import type { Env } from "~/env"
import { createDoLogger, runDoOperation } from "~/observability"
import {
  APPLY_BATCH_SIZE_LIMIT,
  FLUSH_BATCH_SIZE,
  FLUSH_INTERVAL_MS,
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  OUTBOX_DEPTH_ALERT_THRESHOLD,
  WALLET_RESERVATION_ROW_ID,
} from "./constants"
import {
  entitlementConfigTable,
  grantWindowsTable,
  grantsTable,
  idempotencyKeyBatchesTable,
  meterFactsOutboxBatchesTable,
  meterStateTable,
  schema,
  walletReservationTable,
} from "./db/schema"
import migrations from "./drizzle/migrations"
import { InMemoryMeterStorageAdapter, type MeterStateDraft } from "./meter-state-adapter"
import {
  inactivityThresholdMs,
  jsonEquals,
  maxFlushIntervalMs,
  minNullableExpiry,
  unique,
} from "./utils"

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

// Raised when the wallet really cannot fund the current event. The DO converts
// this into a denied ApplyResult, persists the denial to the idempotency table,
// and returns WALLET_EMPTY so retries are stable.
class EntitlementWindowWalletEmptyError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      meterSlug: string
      reservationId: string
      cost: number
      remaining: number
      eventTimestamp: number
    }
  ) {
    super(`Wallet empty for meter ${params.meterSlug} (reservation ${params.reservationId})`)
    this.name = EntitlementWindowWalletEmptyError.name
  }
}

// Raised from the SQLite transaction when the local reservation is too small
// for the current event. The caller can then do external wallet I/O outside the
// transaction, grow the reservation, and retry once before returning
// WALLET_EMPTY.
class EntitlementWindowReservationUnderfundedError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      meterSlug: string
      reservationId: string
      cost: number
      remaining: number
      eventTimestamp: number
    }
  ) {
    super(`Reservation underfunded for meter ${params.meterSlug}`)
    this.name = EntitlementWindowReservationUnderfundedError.name
  }
}

class EntitlementWindowBatchSequentialReplayRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = EntitlementWindowBatchSequentialReplayRequired.name
  }
}

type DeniedReason = Extract<
  IngestionRejectionReason,
  "LIMIT_EXCEEDED" | "WALLET_EMPTY" | "LATE_EVENT_CLOSED_PERIOD"
>

type ApplyResult = {
  allowed: boolean
  deniedReason?: DeniedReason
  message?: string
}

type ApplyInnerOptions = {
  emitLog?: boolean
}

// Internal: bubbled out of the apply() transaction so the post-commit
// scheduler can fire `ctx.waitUntil(requestFlushAndRefill(...))` without
// holding the tx open. Amounts are pgledger scale-8 minor units.
type RefillTrigger = {
  flushSeq: number
  flushAmount: number
  refillAmount: number
  effectiveAt: number
}

type ReservationGrowthResult =
  | { kind: "already_funded" }
  | { kind: "refilled"; trigger: RefillTrigger }

const outboxFactSchema = z
  .object({
    event_id: z.string(),
    idempotency_key: z.string(),
    project_id: z.string(),
    customer_id: z.string(),
    currency: z.string().length(3),
    customer_entitlement_id: z.string(),
    grant_id: z.string(),
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
    amount_after: z.number().int().optional(),
    amount_scale: z.literal(LEDGER_SCALE),
    priced_at: z.number().int(),
  })
  .transform((fact) => ({
    ...fact,
    amount_after: fact.amount_after ?? fact.amount,
  }))

type OutboxFact = z.output<typeof outboxFactSchema>

type OutboxBatchFlushRow = {
  id: number
  payloads: string
}

const rawEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  timestamp: z.number().finite(),
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
  creditLinePolicy: creditLinePolicySchema.default("uncapped"),
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
  now: z.number().finite(),
})

const applyBatchEventSchema = rawEventSchema.extend({
  correlationKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
  now: z.number().finite(),
})

const applyBatchInputSchema = applyInputSchema
  .omit({ event: true, idempotencyKey: true, now: true })
  .extend({
    events: z.array(applyBatchEventSchema).min(1).max(APPLY_BATCH_SIZE_LIMIT),
  })

const enforcementStateInputSchema = z.object({
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema),
  now: z.number().finite(),
})

const batchIdempotencyEntrySchema = z.object({
  eventId: z.string().min(1),
  createdAt: z.number().finite(),
  allowed: z.boolean(),
  deniedReason: z
    .enum(["LIMIT_EXCEEDED", "WALLET_EMPTY", "LATE_EVENT_CLOSED_PERIOD"] satisfies readonly [
      DeniedReason,
      ...DeniedReason[],
    ])
    .nullable(),
  denyMessage: z.string().nullable(),
})

type BatchIdempotencyEntry = z.infer<typeof batchIdempotencyEntrySchema>

type ApplyInput = z.infer<typeof applyInputSchema>
type ApplyBatchInput = z.infer<typeof applyBatchInputSchema>
type ApplyGrantInput = z.infer<typeof activeGrantSchema>
type ApplyBatchResultRow = ApplyResult & { correlationKey: string; idempotencyKey: string }
type ApplyBatchMetrics = {
  duplicate_count: number
  grant_allocation_count: number
  grant_window_write_count: number
  idempotency_event_count: number
  idempotency_insert_count: number
  meter_state_write_count: number
  outbox_fact_count: number
  outbox_insert_count: number
  priced_fact_count: number
  wallet_reservation_write_count: number
}
type ApplyBatchInternalResult = {
  results: ApplyBatchResultRow[]
  metrics: ApplyBatchMetrics
}

function createApplyBatchMetrics(): ApplyBatchMetrics {
  return {
    duplicate_count: 0,
    grant_allocation_count: 0,
    grant_window_write_count: 0,
    idempotency_event_count: 0,
    idempotency_insert_count: 0,
    meter_state_write_count: 0,
    outbox_fact_count: 0,
    outbox_insert_count: 0,
    priced_fact_count: 0,
    wallet_reservation_write_count: 0,
  }
}

export const entitlementWindowStatusSchema = z.object({
  durableObjectId: z.string(),
  outboxCount: z.number().int(),
  nextAlarmAt: z.number().nullable(),
  lastIdempotencyCleanupAt: z.number().nullable(),
  walletReservation: z
    .object({
      reservationId: z.string().nullable(),
      projectId: z.string().nullable(),
      customerId: z.string().nullable(),
      currency: z.string().nullable(),
      reservationEndAt: z.number().nullable(),
      consumedAmount: z.number().int(),
      flushedAmount: z.number().int(),
      unflushedAmount: z.number().int(),
      allocationAmount: z.number().int(),
      refillInFlight: z.boolean(),
      flushSeq: z.number().int(),
      pendingFlushSeq: z.number().int().nullable(),
      pendingFlushFinal: z.boolean(),
      pendingFlushAmount: z.number().int().nullable(),
      pendingRefillAmount: z.number().int(),
      lastEventAt: z.number().nullable(),
      lastFlushedAt: z.number().nullable(),
      deletionRequested: z.boolean(),
      recoveryRequired: z.boolean(),
    })
    .nullable(),
})

export type EntitlementWindowStatus = z.infer<typeof entitlementWindowStatusSchema>
type EnforcementStateInput = z.infer<typeof enforcementStateInputSchema>
type ActiveGrantInput = ApplyGrantInput & {
  cadenceEffectiveAt: number
  cadenceExpiresAt: number | null
  currencyCode: string
  resetConfig: ResetConfig | null
}
type EntitlementConfigInput = z.infer<typeof entitlementConfigSchema>
type EntitlementCreditLinePolicy = CreditLinePolicy

type MeterIdentity = {
  customerEntitlementId: string
  currency: string
  key: string
  config: MeterConfig
}

type PricedFact = {
  amountAfterMinor: number
  amountMinor: number
  currency: string
  fact: Fact
  featurePlanVersionId: string
  featureSlug: string
  grantId: string
  periodKey: string
  usageAfter: number
  usageBefore: number
  units: number
}

type CloseReservationResult =
  | {
      ok: true
      outcome: "already_reconciled" | "deferred" | "no_reservation" | "success"
      reason?: "deletion_requested" | "pending_wallet_flush" | "recovery_required"
    }
  | {
      errorMessage?: string
      ok: false
      outcome: "exception" | "wallet_error"
    }

type CloseReservationOptions = {
  allowDeletionRequested?: boolean
  closeReason: ReservationCloseReason
  recoverPendingFinal?: boolean
}

type EnforcementStateResult = {
  isLimitReached: boolean
  limit: number | null
  spending: {
    currency: string
    ledgerAmount: number
    scale: typeof LEDGER_SCALE
  }
  usage: number
}

type EnforcementStateCache = {
  entitlement: EntitlementConfigInput | null
  grants: ActiveGrantInput[]
  inputSignature: string | null
  states: GrantConsumptionState[]
}

export class EntitlementWindowDO extends DurableObject {
  private readonly analytics: Analytics
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly logger: Logger
  private readonly ready: Promise<void>
  private readonly runtimeEnv: Env
  // Lazily constructed on the first flush+refill call so a DO that never
  // opens a reservation never opens a Postgres connection.
  private walletService: WalletService | null = null
  private nextAlarmAt: number | null = null
  private lastIdempotencyCleanupAt: number | null = null
  private enforcementStateCache: EnforcementStateCache | null = null
  private batchIdempotencyResults: Map<string, BatchIdempotencyEntry> | null = null
  // In-memory single-flight for lazy reservation bootstrap. It only dedupes
  // external wallet I/O while this DO instance is alive; the reservation row
  // remains the durable source of truth.
  private reservationBootstrapPromise: Promise<ApplyResult | null> | null = null

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
      this.hydrateBatchIdempotencyResults()
      this.nextAlarmAt = await this.ctx.storage.getAlarm()
      const now = Date.now()
      if ((this.nextAlarmAt === null || this.nextAlarmAt <= now) && this.getOutboxCount() > 0) {
        const nextFlushAt = now + FLUSH_INTERVAL_MS
        await this.ctx.storage.setAlarm(nextFlushAt)
        this.nextAlarmAt = nextFlushAt
      }

      // Crash recovery. If the DO was evicted mid-flush, the SQLite row still
      // carries `pending_flush_seq > flush_seq`. Re-issue the flush with the
      // same seq — WalletService dedupes via the ledger
      // idempotency key `flush:{reservationId}:{flushSeq}`, so a duplicate
      // call after a successful commit is a no-op. Newer events accepted
      // after the pending seq was created must wait for the next seq, so
      // replays use the persisted pending amount. NULL means a pre-migration
      // row did not have the field yet, so we fall back to the old derivation.
      const window = this.readWalletReservation(this.db)
      if (
        window?.reservationId &&
        !window.recoveryRequired &&
        !window.deletionRequested &&
        window.pendingFlushSeq !== null &&
        window.pendingFlushSeq !== undefined &&
        window.pendingFlushSeq > window.flushSeq
      ) {
        const flushAmount =
          window.pendingFlushAmount ?? Math.max(0, window.consumedAmount - window.flushedAmount)
        if (window.pendingFlushFinal) {
          this.ctx.waitUntil(
            this.closeReservation({ closeReason: "manual", recoverPendingFinal: true })
          )
        } else {
          // Retry the same refill amount recorded when pendingFlushSeq was
          // created. Recomputing adaptive policy here could change the refill
          // leg behind the same wallet idempotency key.
          this.ctx.waitUntil(
            this.requestFlushAndRefill({
              flushSeq: window.pendingFlushSeq,
              flushAmount,
              refillAmount: window.pendingRefillAmount,
              effectiveAt: Date.now(),
            })
          )
        }
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

  public async applyBatch(rawInput: ApplyBatchInput): Promise<{
    results: ApplyBatchResultRow[]
  }> {
    await this.ready

    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "apply_batch",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => {
        const startTime = Date.now()
        const input = applyBatchInputSchema.parse(rawInput)
        const results: ApplyBatchResultRow[] = []
        let metrics = createApplyBatchMetrics()
        let mode: "optimized" | "sequential" = "optimized"
        let thrown: unknown

        try {
          // Both modes use compact storage. Optimized coalesces a whole batch;
          // sequential replays one event at a time when wallet I/O must happen
          // outside a partially staged batch.
          try {
            const optimized = await this.applyBatchOptimized(input)
            metrics = optimized.metrics
            results.push(...optimized.results)
            return { results: optimized.results }
          } catch (error) {
            if (!(error instanceof EntitlementWindowBatchSequentialReplayRequired)) {
              throw error
            }

            mode = "sequential"
            this.logger.info("entitlement apply_batch falling back to sequential per-event apply", {
              operation: "apply_batch",
              project_id: input.projectId,
              customer_id: input.customerId,
              customer_entitlement_id: input.entitlement.customerEntitlementId,
              event_count: input.events.length,
              reason: error.message,
            })

            const sequential = await this.applyBatchSequential(input)
            metrics = sequential.metrics
            results.push(...sequential.results)
            return { results: sequential.results }
          }
        } catch (error) {
          thrown = error
          throw error
        } finally {
          const deniedByReason = results.reduce<Record<string, number>>((acc, result) => {
            if (!result.allowed && result.deniedReason) {
              acc[result.deniedReason] = (acc[result.deniedReason] ?? 0) + 1
            }
            return acc
          }, {})

          this.logger.info("entitlement apply_batch", {
            operation: "apply_batch",
            project_id: input.projectId,
            customer_id: input.customerId,
            customer_entitlement_id: input.entitlement.customerEntitlementId,
            event_count: input.events.length,
            mode,
            processed_count: results.length,
            allowed_count: results.filter((result) => result.allowed).length,
            denied_count: results.filter((result) => !result.allowed).length,
            ...metrics,
            denied_by_reason: deniedByReason,
            duration_ms: Date.now() - startTime,
            outcome: thrown ? "error" : "success",
            error_type: thrown instanceof Error ? thrown.name : undefined,
            error_message: thrown instanceof Error ? thrown.message : undefined,
          })
        }
      }
    )
  }

  private async applyBatchSequential(input: ApplyBatchInput): Promise<ApplyBatchInternalResult> {
    const results: ApplyBatchResultRow[] = []
    const metrics = createApplyBatchMetrics()

    for (const event of input.events) {
      const { correlationKey, idempotencyKey, now, ...rawEvent } = event
      const result = await this.applyInner(
        {
          ...input,
          event: rawEvent,
          idempotencyKey,
          now,
        },
        { emitLog: false }
      )
      results.push({ ...result, correlationKey, idempotencyKey })
    }

    return { results, metrics }
  }

  private async applyBatchOptimized(input: ApplyBatchInput): Promise<ApplyBatchInternalResult> {
    const createdAt = Date.now()
    const idempotencyKeys = unique(input.events.map((event) => event.idempotencyKey))

    const setup = this.db.transaction((tx) => {
      this.syncEntitlementConfig(tx, {
        entitlement: input.entitlement,
        createdAt,
      })
      this.syncGrants(tx, {
        customerEntitlementId: input.entitlement.customerEntitlementId,
        grants: input.grants,
        createdAt,
      })

      const entitlement = this.readEntitlementConfig(tx)
      if (!entitlement) {
        throw new Error("No entitlement config found after sync")
      }

      const grants = this.readGrants(tx)
      const meter = this.resolveMeterIdentity(entitlement)

      return {
        cachedResults: this.lookupCachedIdempotencyResults(idempotencyKeys),
        entitlement,
        grantStates: this.readGrantStatesForBatch(
          tx,
          grants,
          input.events.map((event) => event.timestamp)
        ),
        grants,
        meter,
        meterState: this.readMeterStateDraft(tx, meter.key, createdAt),
        wallet: this.readWalletReservation(tx),
      }
    })

    const results: ApplyBatchResultRow[] = []
    const metrics = createApplyBatchMetrics()
    const stagedResultsByKey = new Map<string, BatchIdempotencyEntry>()
    const idempotencyEntries: BatchIdempotencyEntry[] = []
    const outboxFacts: OutboxFact[] = []
    const touchedGrantStates = new Map<string, GrantConsumptionState>()
    const grantStates = setup.grantStates.map((state) => ({ ...state }))
    const meterState: MeterStateDraft = { ...setup.meterState }
    let wallet = setup.wallet ? { ...setup.wallet } : null
    let walletDirty = false
    let refillTrigger: RefillTrigger | null = null
    let insertedFactCount = 0

    for (const event of input.events) {
      const activeGrants = resolveActiveGrants(setup.grants, event.timestamp)

      if (activeGrants.length === 0) {
        throw new Error("No active grants found for event timestamp")
      }

      const cached =
        stagedResultsByKey.get(event.idempotencyKey) ??
        setup.cachedResults.get(event.idempotencyKey)
      if (cached) {
        metrics.duplicate_count++
        results.push({
          allowed: cached.allowed,
          deniedReason: cached.deniedReason ?? undefined,
          message: cached.denyMessage ?? undefined,
          correlationKey: event.correlationKey,
          idempotencyKey: event.idempotencyKey,
        })
        continue
      }

      const lateClosedPeriod = this.resolveLateClosedPeriod({
        activeGrants,
        eventTimestamp: event.timestamp,
        now: event.now,
      })

      if (lateClosedPeriod) {
        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "LATE_EVENT_CLOSED_PERIOD",
          message: `Event timestamp is ${lateClosedPeriod.lagMs}ms after the closed period grace window`,
        }
        this.stageBatchIdempotencyResult({
          entries: idempotencyEntries,
          entry: {
            eventId: event.idempotencyKey,
            createdAt,
            allowed: false,
            deniedReason: deniedResult.deniedReason ?? null,
            denyMessage: deniedResult.message ?? null,
          },
          stagedResultsByKey,
        })
        results.push({
          ...deniedResult,
          correlationKey: event.correlationKey,
          idempotencyKey: event.idempotencyKey,
        })
        continue
      }

      const eventInput: ApplyInput = {
        ...input,
        event: {
          id: event.id,
          slug: event.slug,
          timestamp: event.timestamp,
          properties: event.properties,
        },
        idempotencyKey: event.idempotencyKey,
        now: event.now,
      }
      const usesWalletReservation = input.entitlement.creditLinePolicy !== "uncapped"
      const needsBootstrap = usesWalletReservation && (!wallet || wallet.reservationId === null)

      if (needsBootstrap) {
        if (
          idempotencyEntries.length > 0 ||
          outboxFacts.length > 0 ||
          meterState.dirty ||
          touchedGrantStates.size > 0 ||
          walletDirty
        ) {
          throw new EntitlementWindowBatchSequentialReplayRequired(
            "wallet bootstrap after staged batch mutations"
          )
        }

        const projectedCost = this.computeProjectedBatchEventCostMinor({
          activeGrants,
          entitlement: eventInput.entitlement,
          event: eventInput.event,
          eventTimestamp: event.timestamp,
          grantStates,
          meter: setup.meter,
          meterState,
        })

        if (projectedCost > 0) {
          const denial = await this.bootstrapReservationForProjectedCost({
            activeGrants,
            input: eventInput,
            meter: setup.meter,
            projectedCost,
          })

          if (denial) {
            this.stageBatchIdempotencyResult({
              entries: idempotencyEntries,
              entry: {
                eventId: event.idempotencyKey,
                createdAt,
                allowed: false,
                deniedReason: denial.deniedReason ?? null,
                denyMessage: denial.message ?? null,
              },
              stagedResultsByKey,
            })
            results.push({
              ...denial,
              correlationKey: event.correlationKey,
              idempotencyKey: event.idempotencyKey,
            })
            continue
          }

          wallet = this.readWalletReservation(this.db)
        }
      }

      let facts: Fact[]
      try {
        const adapter = new InMemoryMeterStorageAdapter(meterState)
        const engine = new AsyncMeterAggregationEngine([setup.meter.config], adapter, event.now)
        facts = engine.applyEventSync(eventInput.event, {
          beforePersist: (pendingFacts) => {
            if (!input.enforceLimit) {
              return
            }

            const exceeded = this.findGrantLimitExceededFact({
              activeGrants,
              facts: pendingFacts,
              overageStrategy: setup.entitlement.overageStrategy,
              states: this.selectGrantStatesForActiveGrants(
                activeGrants,
                grantStates,
                event.timestamp
              ),
              entitlement: setup.entitlement,
              timestamp: event.timestamp,
            })

            if (exceeded) {
              throw new EntitlementWindowLimitExceededError({
                available: exceeded.available,
                eventId: event.id,
                meterKey: exceeded.fact.meterKey,
              })
            }
          },
        })
      } catch (error) {
        if (!(error instanceof EntitlementWindowLimitExceededError)) {
          throw error
        }

        if (
          usesWalletReservation &&
          wallet?.reservationId &&
          (idempotencyEntries.length > 0 ||
            outboxFacts.length > 0 ||
            meterState.dirty ||
            touchedGrantStates.size > 0 ||
            walletDirty)
        ) {
          throw new EntitlementWindowBatchSequentialReplayRequired(
            "wallet reservation close after staged batch mutations"
          )
        }

        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "LIMIT_EXCEEDED",
          message: error.message,
        }
        this.stageBatchIdempotencyResult({
          entries: idempotencyEntries,
          entry: {
            eventId: event.idempotencyKey,
            createdAt,
            allowed: false,
            deniedReason: deniedResult.deniedReason ?? null,
            denyMessage: deniedResult.message ?? null,
          },
          stagedResultsByKey,
        })
        this.ctx.waitUntil(this.closeReservation({ closeReason: "limit_reached" }))
        results.push({
          ...deniedResult,
          correlationKey: event.correlationKey,
          idempotencyKey: event.idempotencyKey,
        })
        continue
      }

      insertedFactCount += facts.length
      const { pricedFacts, touchedStates } = this.priceFactsFromGrantStates({
        activeGrants,
        entitlement: setup.entitlement,
        eventTimestamp: event.timestamp,
        facts,
        grantStates,
      })
      metrics.priced_fact_count += pricedFacts.length
      metrics.grant_allocation_count += touchedStates.size

      for (const [bucketKey, state] of touchedStates.entries()) {
        touchedGrantStates.set(bucketKey, state)
      }

      if (usesWalletReservation && wallet?.reservationId && pricedFacts.length > 0) {
        const totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)
        const effectiveCost = computeEffectiveWalletCost({
          requestedCostAmount: totalCost,
          consumedAmount: wallet.consumedAmount,
          flushedAmount: wallet.flushedAmount,
        })
        const currentRemaining = Math.max(0, wallet.allocationAmount - wallet.consumedAmount)

        if (effectiveCost.effectiveCostAmount > currentRemaining) {
          throw new EntitlementWindowBatchSequentialReplayRequired("wallet reservation underfunded")
        }

        const nextConsumedAmount = wallet.consumedAmount + effectiveCost.effectiveCostAmount
        const currentEventCostAmount = Math.max(0, totalCost)
        const pricePerEventAmount = Math.max(
          currentEventCostAmount,
          computeMaxMarginalPriceMinor(setup.entitlement.featureConfig)
        )
        const flushAmount = Math.max(0, nextConsumedAmount - wallet.flushedAmount)
        const hasPendingNonFinalFlush =
          !wallet.pendingFlushFinal &&
          wallet.pendingFlushSeq !== null &&
          wallet.pendingFlushSeq !== undefined &&
          wallet.pendingFlushSeq > wallet.flushSeq
        let spendVelocity = {
          spendEwmaAmount: wallet.spendEwmaAmount,
          lastRateSampledAtMs: wallet.lastRateSampledAtMs,
        }
        let refillDecision = computeRefillDecision({
          allocationAmount: wallet.allocationAmount,
          consumedAmount: nextConsumedAmount,
          flushedAmount: wallet.flushedAmount,
          targetReservationAmount: wallet.targetReservationAmount,
          spendEwmaAmount: spendVelocity.spendEwmaAmount,
          lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
          maxEventCostAmount: wallet.maxEventCostAmount,
          currentEventCostAmount,
          pricePerEventAmount,
          policy: this.reservationPolicy(),
        })

        if (
          refillDecision.needsRefill &&
          !wallet.refillInFlight &&
          !hasPendingNonFinalFlush &&
          flushAmount > 0
        ) {
          spendVelocity = updateSpendVelocity({
            previousSpendEwmaAmount: wallet.spendEwmaAmount,
            previousLastRateSampledAtMs: wallet.lastRateSampledAtMs,
            flushAmount,
            nowMs: createdAt,
            policy: this.reservationPolicy(),
          })
          refillDecision = computeRefillDecision({
            allocationAmount: wallet.allocationAmount,
            consumedAmount: nextConsumedAmount,
            flushedAmount: wallet.flushedAmount,
            targetReservationAmount: wallet.targetReservationAmount,
            spendEwmaAmount: spendVelocity.spendEwmaAmount,
            lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
            maxEventCostAmount: wallet.maxEventCostAmount,
            currentEventCostAmount,
            pricePerEventAmount,
            policy: this.reservationPolicy(),
          })
        }

        wallet = {
          ...wallet,
          consumedAmount: nextConsumedAmount,
          targetReservationAmount: refillDecision.targetReservationAmount,
          spendEwmaAmount: spendVelocity.spendEwmaAmount,
          lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
          maxEventCostAmount: refillDecision.maxEventCostAmount,
          lastEventAt: createdAt,
        }
        walletDirty = true

        const shouldScheduleRefill =
          !wallet.refillInFlight &&
          (hasPendingNonFinalFlush ||
            (refillDecision.needsRefill && refillDecision.refillAmount > 0))

        if (shouldScheduleRefill) {
          const nextSeq = hasPendingNonFinalFlush ? wallet.pendingFlushSeq! : wallet.flushSeq + 1
          const pendingFlushAmount = hasPendingNonFinalFlush
            ? (wallet.pendingFlushAmount ?? flushAmount)
            : flushAmount
          const refillAmount = hasPendingNonFinalFlush
            ? wallet.pendingRefillAmount
            : refillDecision.refillAmount

          wallet = {
            ...wallet,
            refillInFlight: true,
            pendingFlushSeq: nextSeq,
            pendingFlushFinal: false,
            pendingFlushAmount,
            pendingRefillAmount: refillAmount,
          }
          refillTrigger = {
            flushSeq: nextSeq,
            flushAmount: pendingFlushAmount,
            refillAmount,
            effectiveAt: event.timestamp,
          }
        }
      } else if (wallet?.reservationId) {
        wallet = { ...wallet, lastEventAt: createdAt }
        walletDirty = true
      }

      for (const pricedFact of pricedFacts) {
        outboxFacts.push(
          this.buildOutboxFactPayload({
            createdAt,
            input: eventInput,
            meter: setup.meter,
            pricedFact,
          })
        )
      }

      this.stageBatchIdempotencyResult({
        entries: idempotencyEntries,
        entry: {
          eventId: event.idempotencyKey,
          createdAt,
          allowed: true,
          deniedReason: null,
          denyMessage: null,
        },
        stagedResultsByKey,
      })
      results.push({
        allowed: true,
        correlationKey: event.correlationKey,
        idempotencyKey: event.idempotencyKey,
      })
    }

    if (
      meterState.dirty ||
      touchedGrantStates.size > 0 ||
      outboxFacts.length > 0 ||
      idempotencyEntries.length > 0 ||
      walletDirty
    ) {
      metrics.meter_state_write_count = meterState.dirty ? (meterState.exists ? 1 : 2) : 0
      metrics.grant_window_write_count = touchedGrantStates.size
      metrics.wallet_reservation_write_count = walletDirty && wallet ? 1 : 0
      metrics.outbox_insert_count = outboxFacts.length > 0 ? 1 : 0
      metrics.outbox_fact_count = outboxFacts.length
      metrics.idempotency_insert_count = idempotencyEntries.length > 0 ? 1 : 0
      metrics.idempotency_event_count = idempotencyEntries.length

      // Keep replay seals, priced fact publish intent, and local accounting in one
      // synchronous DO SQLite transaction. No await belongs inside this block.
      this.db.transaction((tx) => {
        if (meterState.dirty) {
          this.ensureMeterState(tx, {
            meterKey: setup.meter.key,
            createdAt: meterState.createdAt,
          })
          tx.update(meterStateTable)
            .set({
              usage: meterState.usage,
              updatedAt: meterState.updatedAt,
            })
            .where(eq(meterStateTable.meterKey, setup.meter.key))
            .run()
        }

        for (const state of touchedGrantStates.values()) {
          this.writeGrantConsumption(tx, state)
        }

        if (outboxFacts.length > 0) {
          tx.insert(meterFactsOutboxBatchesTable)
            .values({
              payloads: JSON.stringify(outboxFacts),
              currency: setup.meter.currency,
              createdAt,
            })
            .run()
        }

        if (idempotencyEntries.length > 0) {
          tx.insert(idempotencyKeyBatchesTable)
            .values({
              createdAt,
              entries: JSON.stringify(idempotencyEntries),
            })
            .run()
        }

        if (walletDirty && wallet) {
          tx.update(walletReservationTable)
            .set({
              consumedAmount: wallet.consumedAmount,
              targetReservationAmount: wallet.targetReservationAmount,
              spendEwmaAmount: wallet.spendEwmaAmount,
              lastRateSampledAtMs: wallet.lastRateSampledAtMs,
              maxEventCostAmount: wallet.maxEventCostAmount,
              refillInFlight: wallet.refillInFlight,
              pendingFlushSeq: wallet.pendingFlushSeq,
              pendingFlushFinal: wallet.pendingFlushFinal,
              pendingFlushAmount: wallet.pendingFlushAmount,
              pendingRefillAmount: wallet.pendingRefillAmount,
              lastEventAt: wallet.lastEventAt,
            })
            .run()
        }
      })

      this.recordBatchIdempotencyResults(idempotencyEntries)
      this.invalidateEnforcementStateCache()
    }

    if (insertedFactCount > 0 || this.getOutboxCount() > 0) {
      await this.scheduleAlarmCoalesced(Date.now() + FLUSH_INTERVAL_MS)
    }

    if (refillTrigger) {
      this.ctx.waitUntil(this.requestFlushAndRefill(refillTrigger))
    }

    return { results, metrics }
  }

  private async applyInner(
    rawInput: ApplyInput,
    options: ApplyInnerOptions = {}
  ): Promise<ApplyResult> {
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
    const creditLinePolicy: EntitlementCreditLinePolicy = input.entitlement.creditLinePolicy

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
      credit_line_policy: creditLinePolicy,
    }

    let result: ApplyResult | undefined
    let thrown: unknown
    let duplicateCount = 0
    let insertedFactCount = 0
    let pricedFactCount = 0
    let grantAllocationCount = 0
    let meterStateWriteCount = 0
    let grantWindowWriteCount = 0
    let walletReservationWriteCount = 0
    let outboxInsertCount = 0
    let outboxFactCount = 0
    let idempotencyInsertCount = 0
    let refillTrigger: RefillTrigger | null = null
    let totalCost = 0
    let reservationEngaged = false

    try {
      // Idempotency short-circuit before any wallet I/O. A retried event with a
      // cached result must not re-call wallet.createReservation.
      const cachedResult = this.lookupCachedIdempotencyResult(idempotencyKey)
      if (cachedResult) {
        duplicateCount = 1
        wideEvent.idempotent_replay = true
        result = cachedResult
        return cachedResult
      }
      wideEvent.idempotent_replay = false

      const lateClosedPeriod = this.resolveLateClosedPeriod({
        activeGrants,
        eventTimestamp: input.event.timestamp,
        now: input.now,
      })

      if (lateClosedPeriod) {
        const deniedResult: ApplyResult = {
          allowed: false,
          deniedReason: "LATE_EVENT_CLOSED_PERIOD",
          message: `Event timestamp is ${lateClosedPeriod.lagMs}ms after the closed period grace window`,
        }

        this.persistBatchIdempotencyResult({
          eventId: idempotencyKey,
          createdAt,
          allowed: false,
          deniedReason: deniedResult.deniedReason ?? null,
          denyMessage: deniedResult.message ?? null,
        })
        idempotencyInsertCount = 1

        wideEvent.late_event_rejected = true
        wideEvent.late_event_lag_ms = lateClosedPeriod.lagMs
        wideEvent.late_event_period_end_at = lateClosedPeriod.periodEndAt
        result = deniedResult
        return deniedResult
      }
      wideEvent.late_event_rejected = false

      // Lazy reservation bootstrap. If this DO has never opened a reservation
      // for the current period, only open one when the current event produces a
      // positive priced delta. Free-tier events stay off the wallet path; the
      // first paid boundary-crossing event bootstraps the wallet.
      //
      // Out-of-tx because Postgres ↔ SQLite can't share a single transaction.
      // A small in-memory single-flight prevents duplicate wallet calls while
      // this DO instance is awaiting external I/O.
      const preWindow = this.readWalletReservation(this.db)
      const usesWalletReservation = creditLinePolicy !== "uncapped"
      const needsBootstrap =
        usesWalletReservation && (!preWindow || preWindow.reservationId === null)
      wideEvent.bootstrap_attempted = needsBootstrap

      if (needsBootstrap) {
        let denial: ApplyResult | null
        try {
          denial = await this.bootstrapReservationSingleFlight(input, activeGrants, meter)
        } catch (error) {
          wideEvent.bootstrap_outcome = "error"
          throw error
        }

        if (denial) {
          wideEvent.bootstrap_outcome = "denied"
          // Persist the denial idempotently so retries return the same answer
          // without re-calling the wallet. The DO's normal denial-cache pattern.
          this.persistBatchIdempotencyResult({
            eventId: idempotencyKey,
            createdAt,
            allowed: false,
            deniedReason: denial.deniedReason ?? null,
            denyMessage: denial.message ?? null,
          })
          idempotencyInsertCount = 1
          result = denial
          return denial
        }
        wideEvent.bootstrap_outcome = "success"
      } else if (!usesWalletReservation) {
        wideEvent.bootstrap_outcome = "disabled_by_credit_line_policy"
      } else {
        wideEvent.bootstrap_outcome = "reservation_already_open"
      }

      let synchronousRefillAttempted = false
      for (;;) {
        refillTrigger = null

        try {
          const txResult = this.db.transaction((tx) => {
            const existingBatchEntry = this.getBatchIdempotencyResults().get(idempotencyKey)
            if (existingBatchEntry) {
              duplicateCount = 1
              return {
                idempotencyEntry: null,
                result: {
                  allowed: existingBatchEntry.allowed,
                  deniedReason: existingBatchEntry.deniedReason ?? undefined,
                  message: existingBatchEntry.denyMessage ?? undefined,
                },
              }
            }

            const meterState = this.readMeterStateDraft(tx, meter.key, createdAt)
            const adapter = new InMemoryMeterStorageAdapter(meterState)
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
                  states: this.readGrantStatesForActiveGrants(
                    tx,
                    activeGrants,
                    input.event.timestamp
                  ),
                  entitlement,
                  timestamp: input.event.timestamp,
                })

                if (exceeded) {
                  throw new EntitlementWindowLimitExceededError({
                    available: exceeded.available,
                    eventId: input.event.id,
                    meterKey: exceeded.fact.meterKey,
                  })
                }
              },
            })

            insertedFactCount = facts.length

            if (meterState.dirty) {
              meterStateWriteCount = meterState.exists ? 1 : 2
              this.ensureMeterState(tx, {
                meterKey: meter.key,
                createdAt: meterState.createdAt,
              })
              tx.update(meterStateTable)
                .set({
                  usage: meterState.usage,
                  updatedAt: meterState.updatedAt,
                })
                .where(eq(meterStateTable.meterKey, meter.key))
                .run()
            }

            const priced = this.priceFactsFromGrantWindows(tx, {
              activeGrants,
              entitlement,
              eventTimestamp: input.event.timestamp,
              facts,
            })
            const pricedFacts = priced.pricedFacts
            pricedFactCount = pricedFacts.length
            grantAllocationCount = priced.touchedStateCount
            grantWindowWriteCount = priced.touchedStateCount

            // Wallet check. Only engages when a reservation has been opened on
            // this window. Without a reservation the DO operates without local
            // allocation tracking or refill triggers.
            const window = this.readWalletReservation(tx)
            let walletLastEventAtStamped = false
            if (usesWalletReservation && window?.reservationId && pricedFacts.length > 0) {
              reservationEngaged = true
              // Pricing has already run through Dinero and was normalized into
              // ledger-scale integers. Mixed currencies are rejected at grant sync.
              totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)

              const effectiveCost = computeEffectiveWalletCost({
                requestedCostAmount: totalCost,
                consumedAmount: window.consumedAmount,
                flushedAmount: window.flushedAmount,
              })
              const currentRemaining = Math.max(0, window.allocationAmount - window.consumedAmount)

              if (effectiveCost.effectiveCostAmount > currentRemaining) {
                throw new EntitlementWindowReservationUnderfundedError({
                  eventId: input.event.id,
                  meterKey: meter.key,
                  meterSlug: meter.config.eventSlug,
                  reservationId: window.reservationId,
                  cost: totalCost,
                  remaining: currentRemaining,
                  eventTimestamp: input.event.timestamp,
                })
              }

              const nextConsumedAmount = window.consumedAmount + effectiveCost.effectiveCostAmount
              const currentEventCostAmount = Math.max(0, totalCost)
              const pricePerEventAmount = Math.max(
                currentEventCostAmount,
                computeMaxMarginalPriceMinor(entitlement.featureConfig)
              )
              const flushAmount = Math.max(0, nextConsumedAmount - window.flushedAmount)
              const hasPendingNonFinalFlush =
                !window.pendingFlushFinal &&
                window.pendingFlushSeq !== null &&
                window.pendingFlushSeq !== undefined &&
                window.pendingFlushSeq > window.flushSeq
              let spendVelocity = {
                spendEwmaAmount: window.spendEwmaAmount,
                lastRateSampledAtMs: window.lastRateSampledAtMs,
              }
              let refillDecision = computeRefillDecision({
                allocationAmount: window.allocationAmount,
                consumedAmount: nextConsumedAmount,
                flushedAmount: window.flushedAmount,
                targetReservationAmount: window.targetReservationAmount,
                spendEwmaAmount: spendVelocity.spendEwmaAmount,
                lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
                maxEventCostAmount: window.maxEventCostAmount,
                currentEventCostAmount,
                pricePerEventAmount,
                policy: this.reservationPolicy(),
              })

              if (
                refillDecision.needsRefill &&
                !window.refillInFlight &&
                !hasPendingNonFinalFlush &&
                flushAmount > 0
              ) {
                // Only sample velocity for a new refill decision. If a prior
                // flush seq is pending, retry the persisted refill amount
                // instead of changing the ledger request for that seq.
                spendVelocity = updateSpendVelocity({
                  previousSpendEwmaAmount: window.spendEwmaAmount,
                  previousLastRateSampledAtMs: window.lastRateSampledAtMs,
                  flushAmount,
                  nowMs: createdAt,
                  policy: this.reservationPolicy(),
                })
                refillDecision = computeRefillDecision({
                  allocationAmount: window.allocationAmount,
                  consumedAmount: nextConsumedAmount,
                  flushedAmount: window.flushedAmount,
                  targetReservationAmount: window.targetReservationAmount,
                  spendEwmaAmount: spendVelocity.spendEwmaAmount,
                  lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
                  maxEventCostAmount: window.maxEventCostAmount,
                  currentEventCostAmount,
                  pricePerEventAmount,
                  policy: this.reservationPolicy(),
                })
              }

              wideEvent.wallet_raw_cost_minor = totalCost
              wideEvent.wallet_effective_cost_minor = effectiveCost.effectiveCostAmount
              wideEvent.wallet_clamped_negative_minor = effectiveCost.clampedNegativeAmount
              wideEvent.reservation_remaining_amount = refillDecision.remainingAmount
              wideEvent.reservation_target_amount = refillDecision.targetReservationAmount
              wideEvent.reservation_threshold_amount = refillDecision.watermarkAmount
              wideEvent.reservation_refill_requested_amount = refillDecision.refillAmount

              // Synchronous SQLite write before any post-commit action. On
              // replay the idempotency row short-circuits above, so this only
              // runs on the first-success path.
              tx.update(walletReservationTable)
                .set({
                  consumedAmount: nextConsumedAmount,
                  targetReservationAmount: refillDecision.targetReservationAmount,
                  spendEwmaAmount: spendVelocity.spendEwmaAmount,
                  lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
                  maxEventCostAmount: refillDecision.maxEventCostAmount,
                  lastEventAt: createdAt,
                })
                .run()
              walletReservationWriteCount++
              walletLastEventAtStamped = true

              const shouldScheduleRefill =
                !window.refillInFlight &&
                (hasPendingNonFinalFlush ||
                  (refillDecision.needsRefill && refillDecision.refillAmount > 0))

              if (shouldScheduleRefill) {
                const nextSeq = hasPendingNonFinalFlush
                  ? window.pendingFlushSeq!
                  : window.flushSeq + 1
                const pendingFlushAmount = hasPendingNonFinalFlush
                  ? (window.pendingFlushAmount ?? flushAmount)
                  : flushAmount
                const refillAmount = hasPendingNonFinalFlush
                  ? window.pendingRefillAmount
                  : refillDecision.refillAmount

                // pendingRefillAmount is part of the idempotency envelope for
                // flush:{reservationId}:{flushSeq}. Crash recovery may fold in
                // newer unflushed consumption, but the refill leg for an
                // existing seq must stay stable.
                tx.update(walletReservationTable)
                  .set({
                    refillInFlight: true,
                    pendingFlushSeq: nextSeq,
                    pendingFlushFinal: false,
                    pendingFlushAmount,
                    pendingRefillAmount: refillAmount,
                  })
                  .run()
                walletReservationWriteCount++

                refillTrigger = {
                  flushSeq: nextSeq,
                  // Flush leg = cumulative consumed - already flushed. Zero on the
                  // first refill means capture skips the recognize leg.
                  flushAmount: pendingFlushAmount,
                  refillAmount,
                  effectiveAt: input.event.timestamp,
                }
              }
            }

            const outboxFacts = pricedFacts.map((pricedFact) =>
              this.buildOutboxFactPayload({
                createdAt,
                input,
                meter,
                pricedFact,
              })
            )

            this.writeBatchOutboxFacts(tx, outboxFacts, meter.currency, createdAt)
            outboxInsertCount = outboxFacts.length > 0 ? 1 : 0
            outboxFactCount = outboxFacts.length

            const idempotencyEntry: BatchIdempotencyEntry = {
              eventId: idempotencyKey,
              createdAt,
              allowed: true,
              deniedReason: null,
              denyMessage: null,
            }
            this.writeBatchIdempotencyResults(tx, [idempotencyEntry])
            idempotencyInsertCount = 1

            // Stamp the inactivity watermark on every successful commit. alarm()
            // uses `now - lastEventAt > INACTIVITY_THRESHOLD_MS` to decide when to
            // close out a dormant reservation without waiting for period end.
            if (window?.reservationId && !walletLastEventAtStamped) {
              tx.update(walletReservationTable).set({ lastEventAt: createdAt }).run()
              walletReservationWriteCount++
            }

            return {
              idempotencyEntry,
              result: { allowed: true } as ApplyResult,
            }
          })

          if (txResult.idempotencyEntry) {
            this.recordBatchIdempotencyResults([txResult.idempotencyEntry])
          }

          if (txResult.result.allowed && insertedFactCount > 0) {
            await this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS)
          }

          // Flush+refill must happen after commit so the new consumed/refill
          // state is visible to `requestFlushAndRefill`, and must outlive the
          // request via `ctx.waitUntil` so it continues after apply() returns.
          if (refillTrigger) {
            this.ctx.waitUntil(this.requestFlushAndRefill(refillTrigger))
          }

          result = txResult.result
          return txResult.result
        } catch (error) {
          let handledError: unknown = error

          if (handledError instanceof EntitlementWindowReservationUnderfundedError) {
            if (!synchronousRefillAttempted) {
              synchronousRefillAttempted = true
              wideEvent.sync_refill_attempted = true
              wideEvent.sync_refill_cost_minor = handledError.params.cost
              wideEvent.sync_refill_remaining_minor = handledError.params.remaining

              const growth = await this.growReservationForCurrentEvent(handledError.params)

              if (growth) {
                wideEvent.sync_refill_outcome = growth.kind
                if (growth.kind === "refilled") {
                  wideEvent.sync_refill_seq = growth.trigger.flushSeq
                  wideEvent.sync_refill_flush_amount = growth.trigger.flushAmount
                  wideEvent.sync_refill_requested_amount = growth.trigger.refillAmount
                }
                continue
              }
            }

            handledError = new EntitlementWindowWalletEmptyError(handledError.params)
          }

          if (handledError instanceof EntitlementWindowLimitExceededError) {
            const deniedResult: ApplyResult = {
              allowed: false,
              deniedReason: "LIMIT_EXCEEDED",
              message: handledError.message,
            }

            // limit exceeded is a valid state
            this.persistBatchIdempotencyResult({
              eventId: idempotencyKey,
              createdAt,
              allowed: false,
              deniedReason: deniedResult.deniedReason ?? null,
              denyMessage: deniedResult.message ?? null,
            })
            idempotencyInsertCount = 1

            this.ctx.waitUntil(this.closeReservation({ closeReason: "limit_reached" }))
            result = deniedResult
            return deniedResult
          }

          if (handledError instanceof EntitlementWindowWalletEmptyError) {
            const deniedResult: ApplyResult = {
              allowed: false,
              deniedReason: "WALLET_EMPTY",
              message: handledError.message,
            }

            // wallet empty is a valid state as well. By this point the DO has
            // already made one synchronous growth attempt when the local
            // reservation was the only thing short of funding the event.
            this.persistBatchIdempotencyResult({
              eventId: idempotencyKey,
              createdAt,
              allowed: false,
              deniedReason: deniedResult.deniedReason ?? null,
              denyMessage: deniedResult.message ?? null,
            })
            idempotencyInsertCount = 1

            this.ctx.waitUntil(this.closeReservation({ closeReason: "wallet_empty" }))

            result = deniedResult
            return deniedResult
          }

          if (
            handledError instanceof EventTimestampTooFarInFutureError ||
            handledError instanceof EventTimestampTooOldError
          ) {
            throw handledError
          }

          throw handledError
        }
      }
    } catch (error) {
      thrown = error
      throw error
    } finally {
      wideEvent.event_count = 1
      wideEvent.processed_count = result ? 1 : 0
      wideEvent.duplicate_count = duplicateCount
      wideEvent.fact_count = insertedFactCount
      wideEvent.priced_fact_count = pricedFactCount
      wideEvent.grant_allocation_count = grantAllocationCount
      wideEvent.meter_state_write_count = meterStateWriteCount
      wideEvent.grant_window_write_count = grantWindowWriteCount
      wideEvent.wallet_reservation_write_count = walletReservationWriteCount
      wideEvent.outbox_insert_count = outboxInsertCount
      wideEvent.outbox_fact_count = outboxFactCount
      wideEvent.idempotency_insert_count = idempotencyInsertCount
      wideEvent.cost_minor = totalCost
      wideEvent.reservation_engaged = reservationEngaged

      // refillTrigger is assigned inside a transaction callback, which
      // defeats TS flow analysis here — it still thinks the value is `null`.
      const trigger = refillTrigger as RefillTrigger | null
      wideEvent.refill_triggered = trigger !== null
      if (trigger) {
        wideEvent.refill_seq = trigger.flushSeq
        wideEvent.reservation_refill_requested_amount = trigger.refillAmount
        wideEvent.refill_flush_amount = trigger.flushAmount
      }
      wideEvent.duration_ms = Date.now() - startTime

      if (result) {
        wideEvent.allowed = result.allowed
        wideEvent.denied_reason = result.deniedReason ?? null
        if (!result.allowed) {
          wideEvent.deny_message = result.message ?? null
        }
        wideEvent.outcome = result.allowed ? "success" : "denied"
      } else if (thrown) {
        wideEvent.outcome = "error"
        wideEvent.error_type = thrown instanceof Error ? thrown.name : "unknown"
        wideEvent.error_message = thrown instanceof Error ? thrown.message : String(thrown)
      }

      if (options.emitLog ?? true) {
        this.logger.info("entitlement apply", wideEvent)
      }
    }
  }

  public async getEnforcementState(
    rawInput?: EnforcementStateInput
  ): Promise<EnforcementStateResult> {
    await this.ready

    const input = rawInput ? enforcementStateInputSchema.parse(rawInput) : null
    const timestamp = input?.now ?? Date.now()
    const snapshot = this.readEnforcementStateSnapshot(input, timestamp)
    const { entitlement, states } = snapshot
    const activeGrants = resolveActiveGrants(snapshot.grants, timestamp)

    if (!entitlement || activeGrants.length === 0) {
      return {
        usage: 0,
        limit: null,
        isLimitReached: false,
        spending: {
          currency: "USD",
          ledgerAmount: 0,
          scale: LEDGER_SCALE,
        },
      }
    }

    const usage = resolveConsumedGrantUnits({
      grants: activeGrants,
      states,
      timestamp,
    })
    const spendingAmount = computeUsagePriceDeltaMinor({
      priceConfig: entitlement.featureConfig,
      usageAfter: usage,
      usageBefore: 0,
    })
    const limit = this.resolveTotalGrantUnits(activeGrants)
    const overageStrategy = entitlement.overageStrategy
    const available = resolveAvailableGrantUnits({
      grants: activeGrants,
      states,
      timestamp,
    })

    const currency = this.extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig)

    if (!currency) {
      throw new Error("No currency found for entitlement")
    }

    const isLimitReached =
      overageStrategy !== "always" && limit !== null && Number.isFinite(available) && available <= 0

    return {
      usage,
      limit,
      spending: {
        currency,
        ledgerAmount: spendingAmount,
        scale: LEDGER_SCALE,
      },
      isLimitReached,
    }
  }

  public async getStatus(): Promise<EntitlementWindowStatus> {
    await this.ready

    const window = this.readWalletReservation(this.db)

    return {
      durableObjectId: this.ctx.id.toString(),
      outboxCount: this.getOutboxCount(),
      nextAlarmAt: this.nextAlarmAt ?? (await this.ctx.storage.getAlarm()),
      lastIdempotencyCleanupAt: this.lastIdempotencyCleanupAt,
      walletReservation: window
        ? {
            reservationId: window.reservationId,
            projectId: window.projectId,
            customerId: window.customerId,
            currency: window.currency,
            reservationEndAt: window.reservationEndAt,
            consumedAmount: window.consumedAmount,
            flushedAmount: window.flushedAmount,
            unflushedAmount: Math.max(0, window.consumedAmount - window.flushedAmount),
            allocationAmount: window.allocationAmount,
            refillInFlight: window.refillInFlight,
            flushSeq: window.flushSeq,
            pendingFlushSeq: window.pendingFlushSeq,
            pendingFlushFinal: window.pendingFlushFinal,
            pendingFlushAmount: window.pendingFlushAmount,
            pendingRefillAmount: window.pendingRefillAmount,
            lastEventAt: window.lastEventAt,
            lastFlushedAt: window.lastFlushedAt,
            deletionRequested: window.deletionRequested,
            recoveryRequired: window.recoveryRequired,
          }
        : null,
    }
  }
  async alarm(): Promise<void> {
    await this.ready
    this.nextAlarmAt = null

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
    const now = startTime
    const wideEvent: Record<string, unknown> = {
      operation: "alarm",
    }

    let thrown: unknown

    try {
      const batchRows = this.db
        .select({
          id: meterFactsOutboxBatchesTable.id,
          payloads: meterFactsOutboxBatchesTable.payloads,
        })
        .from(meterFactsOutboxBatchesTable)
        .orderBy(asc(meterFactsOutboxBatchesTable.id))
        .limit(FLUSH_BATCH_SIZE)
        .all()
      let outboxBatchFlushed = false

      if (batchRows.length > 0) {
        outboxBatchFlushed = await this.flushBatchOutboxToTinybird(batchRows)

        if (outboxBatchFlushed) {
          const maxFlushedOutboxBatchId = batchRows.at(-1)?.id
          if (maxFlushedOutboxBatchId !== undefined) {
            this.db
              .delete(meterFactsOutboxBatchesTable)
              .where(lte(meterFactsOutboxBatchesTable.id, maxFlushedOutboxBatchId))
              .run()
          }
        }
      }
      wideEvent.outbox_compact_batch_size = batchRows.length
      wideEvent.outbox_compact_flushed = outboxBatchFlushed
      const tinybirdFlushFailed = batchRows.length > 0 && !outboxBatchFlushed
      wideEvent.tinybird_flush_failed = tinybirdFlushFailed

      // Keep idempotency keys beyond the public ingestion cap so delayed
      // cleanup cannot erase the replay seal for an event we would accept.
      let staleIdempotencyCount = 0
      const runIdempotencyCleanup = this.shouldRunIdempotencyCleanup(now)
      wideEvent.idempotency_cleanup_ran = runIdempotencyCleanup

      if (runIdempotencyCleanup) {
        staleIdempotencyCount = this.cleanupStaleIdempotencyKeys(now)
        this.lastIdempotencyCleanupAt = now
        wideEvent.idempotency_next_cleanup_at = now + IDEMPOTENCY_CLEANUP_INTERVAL_MS
      }

      wideEvent.idempotency_cleaned = staleIdempotencyCount

      const remainingOutboxCount = this.getOutboxCount()
      wideEvent.outbox_remaining = remainingOutboxCount
      wideEvent.outbox_alert = remainingOutboxCount > OUTBOX_DEPTH_ALERT_THRESHOLD

      // Final-flush detection. Any of three triggers converges on the same
      // flush path: period end, inactivity, or an explicit deletion
      // request. A DO without a reservation (or one marked
      // `recoveryRequired`) skips the flush — there's nothing to close out
      // or the last attempt failed terminally and an operator has to look.
      const window = this.readWalletReservation(this.db)
      const inactivityMs = inactivityThresholdMs(this.runtimeEnv)

      wideEvent.reservation_id = window?.reservationId ?? null
      wideEvent.recovery_required = window?.recoveryRequired ?? false

      if (window?.reservationId && !window.recoveryRequired) {
        const isPeriodEnd = window.reservationEndAt !== null && now >= window.reservationEndAt
        const isInactive = window.lastEventAt !== null && now - window.lastEventAt >= inactivityMs
        const isDeletionPending = window.deletionRequested

        if (isPeriodEnd || isInactive || isDeletionPending) {
          const closeReason: ReservationCloseReason = isDeletionPending
            ? "deletion_requested"
            : isPeriodEnd
              ? "period_close"
              : "inactivity"
          wideEvent.close_reservation_reason = closeReason
          const hasPendingWalletFlush = this.hasPendingWalletFlush(window)
          const isPendingFinalFlush = hasPendingWalletFlush && window.pendingFlushFinal
          if (hasPendingWalletFlush && !isPendingFinalFlush) {
            wideEvent.close_reservation_deferred = true
            wideEvent.pending_flush_seq = window.pendingFlushSeq
            wideEvent.refill_in_flight = window.refillInFlight

            if (isDeletionPending) {
              this.logOperatorActionRequired("entitlement deletion has pending wallet flush", {
                pending_flush_seq: window.pendingFlushSeq,
                refill_in_flight: window.refillInFlight,
                reservation_id: window.reservationId,
              })
              wideEvent.operator_action_required = true
              wideEvent.outcome = "operator_required"
              await this.ctx.storage.deleteAlarm()
              return
            }
          }

          if (!hasPendingWalletFlush || isPendingFinalFlush) {
            const closeResult = await this.closeReservation({
              allowDeletionRequested: isDeletionPending,
              closeReason,
              recoverPendingFinal: isPendingFinalFlush,
            })
            wideEvent.close_reservation_ok = closeResult.ok
            wideEvent.close_reservation_outcome = closeResult.outcome
            if (!closeResult.ok) {
              wideEvent.close_reservation_error_message = closeResult.errorMessage ?? null
              wideEvent.operator_action_required = true
              wideEvent.outcome = "operator_required"
              this.logOperatorActionRequired("entitlement wallet reservation close failed", {
                error_message: closeResult.errorMessage ?? null,
                close_reservation_outcome: closeResult.outcome,
                reservation_id: window.reservationId,
              })
              await this.ctx.storage.deleteAlarm()
              return
            }
          }

          if (isDeletionPending) {
            const latestWindow = this.readWalletReservation(this.db)
            const latestOutboxCount = this.getOutboxCount()
            wideEvent.outbox_remaining = latestOutboxCount
            wideEvent.cleanup_complete = this.isCleanupComplete(latestWindow, latestOutboxCount)
            wideEvent.recovery_required = latestWindow?.recoveryRequired ?? false
            wideEvent.pending_wallet_flush = this.hasPendingWalletFlush(latestWindow)

            if (this.isCleanupComplete(latestWindow, latestOutboxCount)) {
              wideEvent.self_destruct = true
              wideEvent.outcome = "deleted"
              await this.ctx.storage.deleteAlarm()
              await this.ctx.storage.deleteAll()
              return
            }

            if (
              tinybirdFlushFailed ||
              this.hasPendingWalletFlush(latestWindow) ||
              (latestWindow?.recoveryRequired ?? false)
            ) {
              wideEvent.self_destruct = false
              wideEvent.operator_action_required = true
              wideEvent.outcome = "operator_required"
              this.logOperatorActionRequired("entitlement deletion cleanup failed", {
                outbox_remaining: latestOutboxCount,
                pending_flush_seq: latestWindow?.pendingFlushSeq ?? null,
                recovery_required: latestWindow?.recoveryRequired ?? false,
                reservation_id: latestWindow ? latestWindow.reservationId : window.reservationId,
                tinybird_flush_failed: tinybirdFlushFailed,
              })
              await this.ctx.storage.deleteAlarm()
              return
            }

            const nextAlarmAt = now + FLUSH_INTERVAL_MS
            wideEvent.self_destruct = false
            wideEvent.next_alarm_at = nextAlarmAt
            wideEvent.outcome = "scheduled"
            await this.scheduleAlarm(nextAlarmAt)
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
      // Re-read the window because closeReservation above may have closed it.
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
          const spendVelocity = updateSpendVelocity({
            previousSpendEwmaAmount: postFlushWindow.spendEwmaAmount,
            previousLastRateSampledAtMs: postFlushWindow.lastRateSampledAtMs,
            flushAmount: unflushed,
            nowMs: now,
            policy: this.reservationPolicy(),
          })
          wideEvent.time_flush_seq = nextSeq
          wideEvent.time_flush_amount = unflushed
          this.db
            .update(walletReservationTable)
            .set({
              refillInFlight: true,
              pendingFlushSeq: nextSeq,
              pendingFlushFinal: false,
              pendingFlushAmount: unflushed,
              pendingRefillAmount: 0,
              spendEwmaAmount: spendVelocity.spendEwmaAmount,
              lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
            })
            .run()
          await this.requestFlushAndRefill({
            flushSeq: nextSeq,
            flushAmount: unflushed,
            // Time-driven flush is purely about ledger freshness — don't
            // top up allocation here. The DO's own refill trigger handles
            // that when the threshold is actually crossed.
            refillAmount: 0,
            effectiveAt: Date.now(),
          })
        }
      }
      wideEvent.time_flush_triggered = timeFlushTriggered

      const lifecycleEndAt = this.readLifecycleEndAt()
      wideEvent.lifecycle_end_at = lifecycleEndAt

      if (!lifecycleEndAt) {
        if (remainingOutboxCount > 0) {
          const nextAlarmAt = now + FLUSH_INTERVAL_MS
          wideEvent.next_alarm_at = nextAlarmAt
          wideEvent.outcome = "scheduled"
          await this.scheduleAlarm(nextAlarmAt)
          return
        }

        // We don't know when this DO can be safely collected, and the outbox is
        // empty. Go to sleep. Next apply() will wake us up.
        wideEvent.outcome = "idle"
        return
      }

      // After the latest known grant/reservation window we keep the DO alive
      // for the full idempotency TTL before self-destructing.
      const selfDestructAt = lifecycleEndAt + DO_IDEMPOTENCY_TTL_MS

      if (now > selfDestructAt) {
        const latestWindow = this.readWalletReservation(this.db)
        wideEvent.cleanup_complete = this.isCleanupComplete(latestWindow, remainingOutboxCount)
        wideEvent.self_destruct_due = true
        wideEvent.pending_wallet_flush = this.hasPendingWalletFlush(latestWindow)
        wideEvent.recovery_required = latestWindow?.recoveryRequired ?? false

        if (this.isCleanupComplete(latestWindow, remainingOutboxCount)) {
          wideEvent.self_destruct = true
          wideEvent.outcome = "deleted"
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.deleteAll()
          return
        }

        if (
          tinybirdFlushFailed ||
          this.hasPendingWalletFlush(latestWindow) ||
          (latestWindow?.recoveryRequired ?? false)
        ) {
          wideEvent.self_destruct = false
          wideEvent.operator_action_required = true
          wideEvent.outcome = "operator_required"
          this.logOperatorActionRequired("entitlement retention cleanup failed", {
            lifecycle_end_at: lifecycleEndAt,
            outbox_remaining: remainingOutboxCount,
            pending_flush_seq: latestWindow?.pendingFlushSeq ?? null,
            recovery_required: latestWindow?.recoveryRequired ?? false,
            self_destruct_at: selfDestructAt,
            tinybird_flush_failed: tinybirdFlushFailed,
          })
          await this.ctx.storage.deleteAlarm()
          return
        }

        const nextAlarmAt = now + FLUSH_INTERVAL_MS
        wideEvent.self_destruct = false
        wideEvent.next_alarm_at = nextAlarmAt
        wideEvent.outcome = "scheduled"
        await this.scheduleAlarm(nextAlarmAt)
        return
      }

      // Pick the soonest among: outbox drain, pending wallet recheck,
      // time-based flush deadline, reservation close deadlines, and
      // self-destruct. Re-read the window because the time-flush above may
      // have just updated `lastFlushedAt`.
      const finalWindow = this.readWalletReservation(this.db)
      const candidates: number[] = []
      const pushFutureCandidate = (timestamp: number | null) => {
        if (timestamp !== null && Number.isFinite(timestamp) && timestamp > now) {
          candidates.push(timestamp)
        }
      }

      if (remainingOutboxCount > 0) {
        candidates.push(now + FLUSH_INTERVAL_MS)
      }

      if (finalWindow?.reservationId && !finalWindow.recoveryRequired) {
        const pendingWalletFlush = this.hasPendingWalletFlush(finalWindow)
        const unflushed = Math.max(0, finalWindow.consumedAmount - finalWindow.flushedAmount)

        if (pendingWalletFlush) {
          candidates.push(now + FLUSH_INTERVAL_MS)
        }

        if (unflushed > 0 && !finalWindow.refillInFlight) {
          const baseline = finalWindow.lastFlushedAt ?? now
          const flushAt = baseline + flushIntervalMs
          candidates.push(flushAt > now ? flushAt : now + FLUSH_INTERVAL_MS)
        }

        pushFutureCandidate(finalWindow.reservationEndAt)
        pushFutureCandidate(
          finalWindow.lastEventAt !== null ? finalWindow.lastEventAt + inactivityMs : null
        )
      }

      if (candidates.length === 0) {
        // Nothing pending — wake up at retention expiry and emit the
        // operator-facing retained-storage alarm.
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
  // closes the reservation when needed, logs the retained state, and leaves any
  // pending cleanup to an operator.
  public async requestDeletion(): Promise<void> {
    await this.ready
    this.db.update(walletReservationTable).set({ deletionRequested: true }).run()
    // Pull the alarm in: don't wait for the next natural FLUSH_INTERVAL_MS
    // tick if one isn't already imminent.
    await this.scheduleAlarm(Date.now())
  }

  // Close a live reservation: capture the unflushed consumed tail, then
  // release unused reserved funds back to the customer's original buckets.
  // Grant expiration is deliberately outside the DO.
  private async closeReservation(
    options: CloseReservationOptions
  ): Promise<CloseReservationResult> {
    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "close_reservation",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => this.closeReservationInner(options)
    )
  }

  private async closeReservationInner(
    options: CloseReservationOptions
  ): Promise<CloseReservationResult> {
    const startTime = Date.now()
    const window = this.readWalletReservation(this.db)
    const wideEvent: Record<string, unknown> = {
      operation: "close_reservation",
      close_reason: options.closeReason,
      reservation_id: window?.reservationId ?? null,
      project_id: window?.projectId ?? null,
      customer_id: window?.customerId ?? null,
      currency: window?.currency ?? null,
      reservation_end_at: window?.reservationEndAt ?? null,
    }

    try {
      if (!window?.reservationId) {
        wideEvent.outcome = "no_reservation"
        return { ok: true, outcome: "no_reservation" }
      }

      if (!window.projectId || !window.customerId) {
        this.logger.error("reservation close requested without reservation identifiers", {
          reservationId: window.reservationId,
          projectId: window.projectId,
          customerId: window.customerId,
        })
        wideEvent.outcome = "no_reservation"
        return { ok: true, outcome: "no_reservation" }
      }

      if (window.recoveryRequired) {
        wideEvent.outcome = "deferred"
        wideEvent.reason = "recovery_required"
        return { ok: true, outcome: "deferred", reason: "recovery_required" }
      }

      if (window.deletionRequested && !options.allowDeletionRequested) {
        wideEvent.outcome = "deferred"
        wideEvent.reason = "deletion_requested"
        return { ok: true, outcome: "deferred", reason: "deletion_requested" }
      }

      const isRecoveringPendingFinal =
        Boolean(options.recoverPendingFinal) &&
        window.pendingFlushFinal &&
        window.pendingFlushSeq !== null &&
        window.pendingFlushSeq !== undefined &&
        window.pendingFlushSeq > window.flushSeq

      if (this.hasPendingWalletFlush(window) && !isRecoveringPendingFinal) {
        wideEvent.outcome = "deferred"
        wideEvent.reason = "pending_wallet_flush"
        wideEvent.pending_flush_seq = window.pendingFlushSeq
        wideEvent.refill_in_flight = window.refillInFlight
        return { ok: true, outcome: "deferred", reason: "pending_wallet_flush" }
      }

      const derivedUnflushed = Math.max(0, window.consumedAmount - window.flushedAmount)
      const unflushed = isRecoveringPendingFinal
        ? (window.pendingFlushAmount ?? derivedUnflushed)
        : derivedUnflushed
      const nextSeq = isRecoveringPendingFinal ? window.pendingFlushSeq! : window.flushSeq + 1
      wideEvent.flush_seq = nextSeq
      wideEvent.flush_amount = unflushed
      wideEvent.recovering_pending_final = isRecoveringPendingFinal

      this.db
        .update(walletReservationTable)
        .set({
          pendingFlushSeq: nextSeq,
          pendingFlushFinal: true,
          pendingFlushAmount: unflushed,
          pendingRefillAmount: 0,
          refillInFlight: true,
        })
        .run()

      const walletService = this.getWalletService()
      const durableObjectId = this.ctx.id.toString()
      const captureResult = await walletService.captureReservationUsage({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: nextSeq,
        amount: unflushed,
        statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
        metadata: {
          requestedBy: "durable_object",
          requestedById: durableObjectId,
          durableObjectId,
        },
        sourceId: durableObjectId,
      })

      if (captureResult.err) {
        if (
          isRecoveringPendingFinal &&
          captureResult.err.message === "WALLET_RESERVATION_ALREADY_RECONCILED"
        ) {
          this.db
            .update(walletReservationTable)
            .set({
              reservationId: null,
              flushedAmount: Math.max(window.flushedAmount, window.consumedAmount),
              flushSeq: nextSeq,
              pendingFlushSeq: null,
              pendingFlushFinal: false,
              pendingFlushAmount: null,
              pendingRefillAmount: 0,
              refillInFlight: false,
              lastFlushedAt: Date.now(),
            })
            .run()

          wideEvent.flushed_amount = Math.max(0, window.consumedAmount - window.flushedAmount)
          wideEvent.flushed_after = Math.max(window.flushedAmount, window.consumedAmount)
          wideEvent.outcome = "already_reconciled"
          return { ok: true, outcome: "already_reconciled" }
        }

        this.logger.error(captureResult.err, {
          context: "reservation close capture failed",
          flushSeq: nextSeq,
          reservationId: window.reservationId,
        })
        // Leave pendingFlushSeq set so an operator can inspect/replay the
        // same seq; the ledger idempotency key keeps replays safe. Mark
        // recoveryRequired so alarm() does not keep trying to close/delete.
        this.db
          .update(walletReservationTable)
          .set({ recoveryRequired: true, refillInFlight: false })
          .run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = captureResult.err.message
        return {
          errorMessage: captureResult.err.message,
          ok: false,
          outcome: "wallet_error",
        }
      }

      const releaseResult = await walletService.releaseReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        closeReason: options.closeReason,
        idempotencyKey: `release:${window.reservationId}:${options.closeReason}`,
        metadata: {
          requestedBy: "durable_object",
          requestedById: durableObjectId,
          durableObjectId,
        },
        sourceId: durableObjectId,
      })

      if (releaseResult.err) {
        if (
          isRecoveringPendingFinal &&
          releaseResult.err.message === "WALLET_RESERVATION_ALREADY_RECONCILED"
        ) {
          this.db
            .update(walletReservationTable)
            .set({
              reservationId: null,
              flushedAmount: Math.max(window.flushedAmount, window.consumedAmount),
              flushSeq: nextSeq,
              pendingFlushSeq: null,
              pendingFlushFinal: false,
              pendingFlushAmount: null,
              pendingRefillAmount: 0,
              refillInFlight: false,
              lastFlushedAt: Date.now(),
            })
            .run()

          wideEvent.flushed_amount = Math.max(0, window.consumedAmount - window.flushedAmount)
          wideEvent.flushed_after = Math.max(window.flushedAmount, window.consumedAmount)
          wideEvent.outcome = "already_reconciled"
          return { ok: true, outcome: "already_reconciled" }
        }

        this.logger.error(releaseResult.err, {
          context: "reservation close release failed",
          flushSeq: nextSeq,
          reservationId: window.reservationId,
        })
        this.db
          .update(walletReservationTable)
          .set({ recoveryRequired: true, refillInFlight: false })
          .run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = releaseResult.err.message
        return {
          errorMessage: releaseResult.err.message,
          ok: false,
          outcome: "wallet_error",
        }
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
          flushedAmount: window.flushedAmount + captureResult.val.capturedAmount,
          flushSeq: nextSeq,
          pendingFlushSeq: null,
          pendingFlushFinal: false,
          pendingFlushAmount: null,
          pendingRefillAmount: 0,
          refillInFlight: false,
          lastFlushedAt: Date.now(),
        })
        .run()

      wideEvent.flushed_amount = captureResult.val.capturedAmount
      wideEvent.flushed_after = window.flushedAmount + captureResult.val.capturedAmount
      wideEvent.released_amount = releaseResult.val.releasedAmount
      wideEvent.restored_granted_amount = releaseResult.val.restoredGrantedAmount
      wideEvent.refunded_purchased_amount = releaseResult.val.refundedPurchasedAmount
      wideEvent.outcome = "success"
      return { ok: true, outcome: "success" }
    } catch (error) {
      this.logger.error(error, {
        context: "reservation close threw unexpectedly",
        flushSeq: window ? window.flushSeq + 1 : null,
        reservationId: window?.reservationId ?? null,
      })
      this.db
        .update(walletReservationTable)
        .set({ recoveryRequired: true, refillInFlight: false })
        .run()
      wideEvent.outcome = "exception"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
      return {
        errorMessage: error instanceof Error ? error.message : String(error),
        ok: false,
        outcome: "exception",
      }
    } finally {
      wideEvent.duration_ms = Date.now() - startTime
      this.logger.info("entitlement close_reservation", wideEvent)
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
  }): { available: number; fact: Fact } | null {
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
        if (available <= 0) return { available, fact }
        available = Math.max(0, available - fact.delta)
        continue
      }

      if (fact.delta > available) {
        return { available, fact }
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
        this.invalidateEnforcementStateCache()
      }
      return
    }

    tx.insert(entitlementConfigTable)
      .values({
        ...values,
        addedAt: params.createdAt,
      })
      .run()
    this.invalidateEnforcementStateCache()
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
      creditLinePolicy: "uncapped",
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
          this.invalidateEnforcementStateCache()
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
        this.invalidateEnforcementStateCache()
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

  private readGrantStatesForActiveGrants(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    const bucketKeys = [
      ...new Set(
        grants
          .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
          .filter((key): key is string => typeof key === "string" && key.length > 0)
      ),
    ]

    if (bucketKeys.length === 0) {
      return []
    }

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
      .where(inArray(grantWindowsTable.bucketKey, bucketKeys))
      .all()
  }

  private readGrantStatesForBatch(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    const bucketKeys = [
      ...new Set(
        timestamps.flatMap((timestamp) =>
          grants
            .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
            .filter((key): key is string => typeof key === "string" && key.length > 0)
        )
      ),
    ]

    if (bucketKeys.length === 0) {
      return []
    }

    const rows: GrantConsumptionState[] = []
    for (let i = 0; i < bucketKeys.length; i += APPLY_BATCH_SIZE_LIMIT) {
      rows.push(
        ...tx
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
          .where(
            inArray(grantWindowsTable.bucketKey, bucketKeys.slice(i, i + APPLY_BATCH_SIZE_LIMIT))
          )
          .all()
      )
    }

    return rows
  }

  private selectGrantStatesForActiveGrants(
    grants: ActiveGrantInput[],
    states: GrantConsumptionState[],
    timestamp: number
  ): GrantConsumptionState[] {
    const activeBucketKeys = new Set(
      grants
        .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
        .filter((key): key is string => typeof key === "string" && key.length > 0)
    )

    return states.filter((state) => activeBucketKeys.has(state.bucketKey))
  }

  private readMeterStateDraft(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    meterKey: string,
    createdAt: number
  ): MeterStateDraft {
    const row = tx
      .select({
        usage: meterStateTable.usage,
        updatedAt: meterStateTable.updatedAt,
      })
      .from(meterStateTable)
      .where(eq(meterStateTable.meterKey, meterKey))
      .get()

    return {
      createdAt,
      dirty: false,
      exists: Boolean(row),
      meterKey,
      updatedAt: row?.updatedAt ?? null,
      usage: Number(row?.usage ?? 0),
    }
  }

  private readEnforcementStateSnapshot(
    input: EnforcementStateInput | null,
    timestamp: number
  ): EnforcementStateCache {
    const inputSignature = input ? this.enforcementStateInputSignature(input, timestamp) : null

    if (
      this.enforcementStateCache &&
      (input === null || this.enforcementStateCache.inputSignature === inputSignature)
    ) {
      return this.enforcementStateCache
    }

    const syncedAt = Date.now()
    const snapshot = this.db.transaction((tx) => {
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

      const entitlement = this.readEntitlementConfig(tx)
      const grants = this.readGrants(tx)
      const activeGrants = resolveActiveGrants(grants, timestamp)

      return {
        entitlement,
        grants,
        inputSignature,
        states: this.readGrantStatesForActiveGrants(tx, activeGrants, timestamp),
      }
    })

    this.enforcementStateCache = snapshot
    return snapshot
  }

  private enforcementStateInputSignature(input: EnforcementStateInput, timestamp: number): string {
    const bucketKeys = [
      ...new Set(
        input.grants
          .map(
            (grant) =>
              computeGrantPeriodBucket(
                {
                  ...grant,
                  cadenceEffectiveAt: input.entitlement.effectiveAt,
                  cadenceExpiresAt: input.entitlement.expiresAt,
                  resetConfig: input.entitlement.resetConfig ?? null,
                },
                timestamp
              )?.bucketKey
          )
          .filter((key): key is string => typeof key === "string" && key.length > 0)
      ),
    ].sort()

    return JSON.stringify({
      entitlement: input.entitlement,
      grants: input.grants,
      bucketKeys,
    })
  }

  private invalidateEnforcementStateCache(): void {
    this.enforcementStateCache = null
  }

  private buildOutboxFactPayload(params: {
    createdAt: number
    input: ApplyInput
    meter: MeterIdentity
    pricedFact: PricedFact
  }): OutboxFact {
    const { createdAt, input, meter, pricedFact } = params

    return {
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
      amount_after: pricedFact.amountAfterMinor,
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
  ): { pricedFacts: PricedFact[]; touchedStateCount: number } {
    const grantStates = params.facts.some((fact) => fact.delta > 0)
      ? this.readGrantStatesForActiveGrants(tx, params.activeGrants, params.eventTimestamp)
      : []
    const { pricedFacts, touchedStates } = this.priceFactsFromGrantStates({
      ...params,
      grantStates,
    })

    for (const state of touchedStates.values()) {
      this.writeGrantConsumption(tx, state)
    }

    return { pricedFacts, touchedStateCount: touchedStates.size }
  }

  private priceFactsFromGrantStates(params: {
    activeGrants: ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    eventTimestamp: number
    facts: Fact[]
    grantStates: GrantConsumptionState[]
  }): {
    pricedFacts: PricedFact[]
    touchedStates: Map<string, GrantConsumptionState>
  } {
    const pricedFacts: PricedFact[] = []
    const touchedStates = new Map<string, GrantConsumptionState>()
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
        states: params.grantStates,
        timestamp: params.eventTimestamp,
        units: fact.delta,
      })

      for (const allocation of consumed.allocations) {
        const amountMinor = computeUsagePriceDeltaMinor({
          priceConfig: params.entitlement.featureConfig,
          usageAfter: allocation.usageAfter,
          usageBefore: allocation.usageBefore,
        })
        const amountAfterMinor = computeUsagePriceDeltaMinor({
          priceConfig: params.entitlement.featureConfig,
          usageAfter: allocation.usageAfter,
          usageBefore: 0,
        })

        pricedFacts.push({
          amountAfterMinor,
          amountMinor,
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

        this.replaceGrantConsumptionState(params.grantStates, allocation.nextState)
        touchedStates.set(allocation.nextState.bucketKey, allocation.nextState)
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

    return { pricedFacts, touchedStates }
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
    const amountMinor = computeUsagePriceDeltaMinor({
      priceConfig: entitlement.featureConfig,
      usageAfter,
      usageBefore,
    })
    const amountAfterMinor = computeUsagePriceDeltaMinor({
      priceConfig: entitlement.featureConfig,
      usageAfter,
      usageBefore: 0,
    })

    return {
      amountAfterMinor,
      amountMinor,
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
      this.invalidateEnforcementStateCache()
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
    this.invalidateEnforcementStateCache()
  }

  private replaceGrantConsumptionState(
    states: GrantConsumptionState[],
    state: GrantConsumptionState
  ): void {
    const index = states.findIndex((candidate) => candidate.bucketKey === state.bucketKey)
    if (index >= 0) {
      states[index] = state
      return
    }

    states.push(state)
  }

  private firstGrantByDrainOrder(grants: ActiveGrantInput[]): ActiveGrantInput {
    const grant = [...grants].sort((left, right) => this.compareGrantDrainOrder(left, right))[0]
    if (!grant) {
      throw new Error("Expected at least one grant")
    }
    return grant
  }

  private resolveLateClosedPeriod(params: {
    activeGrants: ActiveGrantInput[]
    eventTimestamp: number
    now: number
  }): { lagMs: number; periodEndAt: number } | null {
    const grant = this.firstGrantByDrainOrder(params.activeGrants)
    const bucket = computeGrantPeriodBucket(grant, params.eventTimestamp)

    if (!bucket || bucket.end === Number.MAX_SAFE_INTEGER) {
      return null
    }

    const graceEndsAt = bucket.end + LATE_EVENT_GRACE_MS
    if (params.now <= graceEndsAt) {
      return null
    }

    return {
      lagMs: params.now - graceEndsAt,
      periodEndAt: bucket.end,
    }
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
    targetReservationAmount: number
    spendEwmaAmount: number
    lastRateSampledAtMs: number | null
    maxEventCostAmount: number
    pendingRefillAmount: number
    pendingFlushAmount: number | null
    refillInFlight: boolean
    flushSeq: number
    pendingFlushSeq: number | null
    pendingFlushFinal: boolean
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
        targetReservationAmount: walletReservationTable.targetReservationAmount,
        spendEwmaAmount: walletReservationTable.spendEwmaAmount,
        lastRateSampledAtMs: walletReservationTable.lastRateSampledAtMs,
        maxEventCostAmount: walletReservationTable.maxEventCostAmount,
        pendingRefillAmount: walletReservationTable.pendingRefillAmount,
        pendingFlushAmount: walletReservationTable.pendingFlushAmount,
        refillInFlight: walletReservationTable.refillInFlight,
        flushSeq: walletReservationTable.flushSeq,
        pendingFlushSeq: walletReservationTable.pendingFlushSeq,
        pendingFlushFinal: walletReservationTable.pendingFlushFinal,
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
      targetReservationAmount: Number(row.targetReservationAmount ?? 0),
      spendEwmaAmount: Number(row.spendEwmaAmount ?? 0),
      lastRateSampledAtMs: row.lastRateSampledAtMs ?? null,
      maxEventCostAmount: Number(row.maxEventCostAmount ?? 0),
      pendingRefillAmount: Number(row.pendingRefillAmount ?? 0),
      pendingFlushAmount:
        row.pendingFlushAmount === null || row.pendingFlushAmount === undefined
          ? null
          : Number(row.pendingFlushAmount),
      refillInFlight: Boolean(row.refillInFlight),
      flushSeq: Number(row.flushSeq ?? 0),
      pendingFlushSeq: row.pendingFlushSeq ?? null,
      pendingFlushFinal: Boolean(row.pendingFlushFinal),
      lastEventAt: row.lastEventAt ?? null,
      lastFlushedAt: row.lastFlushedAt ?? null,
      deletionRequested: Boolean(row.deletionRequested),
      recoveryRequired: Boolean(row.recoveryRequired),
    }
  }

  private hasPendingWalletFlush(window: ReturnType<typeof this.readWalletReservation>): boolean {
    return Boolean(
      window?.reservationId &&
        (window.refillInFlight ||
          (window.pendingFlushSeq !== null &&
            window.pendingFlushSeq !== undefined &&
            window.pendingFlushSeq > window.flushSeq))
    )
  }

  private isCleanupComplete(
    window: ReturnType<typeof this.readWalletReservation>,
    outboxCount: number
  ): boolean {
    return (
      outboxCount === 0 &&
      !window?.reservationId &&
      !window?.recoveryRequired &&
      !this.hasPendingWalletFlush(window)
    )
  }

  private logOperatorActionRequired(message: string, fields: Record<string, unknown>): void {
    this.logger.warn(message, {
      ...fields,
      operation: "alarm",
      operator_action_required: true,
    })
  }

  private reservationPolicy(): ReservationPolicy {
    return DEFAULT_RESERVATION_POLICY
  }

  private async growReservationForCurrentEvent(
    params: EntitlementWindowReservationUnderfundedError["params"]
  ): Promise<ReservationGrowthResult | null> {
    const window = this.readWalletReservation(this.db)
    if (
      !window?.reservationId ||
      window.reservationId !== params.reservationId ||
      !window.projectId ||
      !window.customerId ||
      window.recoveryRequired ||
      window.deletionRequested
    ) {
      return null
    }

    const currentRemaining = Math.max(0, window.allocationAmount - window.consumedAmount)
    if (params.cost <= currentRemaining) {
      return { kind: "already_funded" }
    }

    const hasPendingFlush =
      window.pendingFlushSeq !== null &&
      window.pendingFlushSeq !== undefined &&
      window.pendingFlushSeq > window.flushSeq

    if (window.refillInFlight && !hasPendingFlush) {
      return null
    }

    if (hasPendingFlush) {
      // A pending seq already has a persisted refill amount. Let normal
      // recovery/retry own it rather than starting a competing sync grow.
      return null
    }

    const flushSeq = window.flushSeq + 1
    const flushAmount = Math.max(0, window.consumedAmount - window.flushedAmount)
    const spendVelocity =
      flushAmount > 0
        ? updateSpendVelocity({
            previousSpendEwmaAmount: window.spendEwmaAmount,
            previousLastRateSampledAtMs: window.lastRateSampledAtMs,
            flushAmount,
            nowMs: Date.now(),
            policy: this.reservationPolicy(),
          })
        : {
            spendEwmaAmount: window.spendEwmaAmount,
            lastRateSampledAtMs: window.lastRateSampledAtMs,
          }
    const currentEventCostAmount = Math.max(0, params.cost)
    const refillDecision = computeRefillDecision({
      allocationAmount: window.allocationAmount,
      consumedAmount: window.consumedAmount,
      flushedAmount: window.flushedAmount,
      targetReservationAmount: window.targetReservationAmount,
      spendEwmaAmount: spendVelocity.spendEwmaAmount,
      lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
      maxEventCostAmount: window.maxEventCostAmount,
      currentEventCostAmount,
      pricePerEventAmount: currentEventCostAmount,
      policy: this.reservationPolicy(),
    })
    const refillAmount = computeSyncGrowRefillAmount({
      remainingAmount: currentRemaining,
      currentEventCostAmount,
      targetReservationAmount: refillDecision.targetReservationAmount,
      maxOutstandingAmount: this.reservationPolicy().maxOutstandingAmount,
    })

    if (refillAmount <= 0) {
      return null
    }

    const trigger: RefillTrigger = {
      flushSeq,
      flushAmount,
      refillAmount,
      effectiveAt: params.eventTimestamp,
    }

    this.db
      .update(walletReservationTable)
      .set({
        refillInFlight: true,
        pendingFlushSeq: flushSeq,
        pendingFlushFinal: false,
        pendingFlushAmount: flushAmount,
        pendingRefillAmount: refillAmount,
        targetReservationAmount: refillDecision.targetReservationAmount,
        spendEwmaAmount: spendVelocity.spendEwmaAmount,
        lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
        maxEventCostAmount: refillDecision.maxEventCostAmount,
      })
      .run()

    await this.requestFlushAndRefill(trigger)

    return { kind: "refilled", trigger }
  }

  // Slice 7.5. Captures consumed reserved funds, then extends reservation
  // runway, and folds the deltas back into the DO's SQLite state.
  //
  // `flushSeq` is the idempotency seal: the ledger dedupes on
  // `capture:{reservationId}:{flushSeq}` / `extend:{reservationId}:{flushSeq}`,
  // so replays after a crash produce the same outcome. On error we only clear `refillInFlight` — the
  // `pendingFlushSeq` stays set so crash recovery (or the next apply()
  // that observes `pendingFlushSeq > flushSeq`) can retry with the same
  // seq and the same persisted amount. Newer local usage waits for the next
  // flush seq instead of changing the payload behind the same idempotency key.
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
          reservation_refill_requested_amount: trigger.refillAmount,
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
      reservation_refill_requested_amount: trigger.refillAmount,
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
          refillAmount: trigger.refillAmount,
        })
        this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "no_reservation"
        return
      }

      const walletService = this.getWalletService()
      const durableObjectId = this.ctx.id.toString()
      const captureResult = await walletService.captureReservationUsage({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: trigger.flushSeq,
        amount: trigger.flushAmount,
        statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
        metadata: {
          requestedBy: "durable_object",
          requestedById: durableObjectId,
          durableObjectId,
        },
        sourceId: durableObjectId,
      })

      if (captureResult.err) {
        this.logger.error(captureResult.err, {
          context: "flush+refill capture failed",
          flushSeq: trigger.flushSeq,
          reservationId: window.reservationId,
        })
        // Clear the single-flight flag so apply() can re-trigger on the
        // next event; leave pendingFlushSeq set so crash recovery picks up
        // the same seq after an eviction.
        this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = captureResult.err.message
        return
      }

      const extendResult = await walletService.extendReservation({
        projectId: window.projectId,
        customerId: window.customerId,
        currency: window.currency as Currency,
        reservationId: window.reservationId,
        flushSeq: trigger.flushSeq,
        requestedAmount: trigger.refillAmount,
        statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
        effectiveAt: new Date(trigger.effectiveAt),
        metadata: {
          requestedBy: "durable_object",
          requestedById: durableObjectId,
          durableObjectId,
        },
        sourceId: durableObjectId,
      })

      if (extendResult.err) {
        this.logger.error(extendResult.err, {
          context: "flush+refill extend failed",
          flushSeq: trigger.flushSeq,
          reservationId: window.reservationId,
        })
        this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
        wideEvent.outcome = "wallet_error"
        wideEvent.error_message = extendResult.err.message
        return
      }

      this.db
        .update(walletReservationTable)
        .set({
          allocationAmount: window.allocationAmount + extendResult.val.grantedAmount,
          flushedAmount: window.flushedAmount + captureResult.val.capturedAmount,
          flushSeq: trigger.flushSeq,
          pendingFlushSeq: null,
          pendingFlushFinal: false,
          pendingFlushAmount: null,
          pendingRefillAmount: 0,
          refillInFlight: false,
          lastFlushedAt: Date.now(),
        })
        .run()

      wideEvent.reservation_refill_granted_amount = extendResult.val.grantedAmount
      wideEvent.reservation_refill_partial =
        trigger.refillAmount > 0 && extendResult.val.grantedAmount < trigger.refillAmount
      wideEvent.granted_amount = extendResult.val.grantedAmount
      wideEvent.flushed_amount = captureResult.val.capturedAmount
      wideEvent.allocation_after = window.allocationAmount + extendResult.val.grantedAmount
      wideEvent.flushed_after = window.flushedAmount + captureResult.val.capturedAmount
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
    const batchEntry = this.getBatchIdempotencyResults().get(eventId)
    if (!batchEntry) return null

    return {
      allowed: batchEntry.allowed,
      deniedReason: batchEntry.deniedReason ?? undefined,
      message: batchEntry.denyMessage ?? undefined,
    }
  }

  private lookupCachedIdempotencyResults(eventIds: string[]): Map<string, BatchIdempotencyEntry> {
    const results = new Map<string, BatchIdempotencyEntry>()
    const uniqueEventIds = unique(eventIds)
    const batched = this.getBatchIdempotencyResults()

    for (const eventId of uniqueEventIds) {
      const entry = batched.get(eventId)
      if (entry) {
        results.set(eventId, entry)
      }
    }

    return results
  }

  private getBatchIdempotencyResults(): Map<string, BatchIdempotencyEntry> {
    if (!this.batchIdempotencyResults) {
      this.hydrateBatchIdempotencyResults()
    }

    return this.batchIdempotencyResults!
  }

  private hydrateBatchIdempotencyResults(): void {
    const results = new Map<string, BatchIdempotencyEntry>()
    const rows = this.db
      .select({
        entries: idempotencyKeyBatchesTable.entries,
      })
      .from(idempotencyKeyBatchesTable)
      .all()

    for (const row of rows) {
      let rawEntries: unknown
      try {
        rawEntries = JSON.parse(row.entries)
      } catch (error) {
        this.logger.warn("skipping unparsable idempotency batch row", {
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      const parsed = z.array(batchIdempotencyEntrySchema).safeParse(rawEntries)
      if (!parsed.success) {
        this.logger.warn("skipping malformed idempotency batch row", {
          error: parsed.error.message,
        })
        continue
      }

      for (const entry of parsed.data) {
        results.set(entry.eventId, entry)
      }
    }

    this.batchIdempotencyResults = results
  }

  private stageBatchIdempotencyResult(params: {
    entries: BatchIdempotencyEntry[]
    entry: BatchIdempotencyEntry
    stagedResultsByKey: Map<string, BatchIdempotencyEntry>
  }): void {
    params.entries.push(params.entry)
    params.stagedResultsByKey.set(params.entry.eventId, params.entry)
  }

  private recordBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    if (entries.length === 0) {
      return
    }

    const results = this.getBatchIdempotencyResults()
    for (const entry of entries) {
      results.set(entry.eventId, entry)
    }
  }

  private persistBatchIdempotencyResult(entry: BatchIdempotencyEntry): void {
    this.writeBatchIdempotencyResults(this.db, [entry])
    this.recordBatchIdempotencyResults([entry])
  }

  private writeBatchIdempotencyResults(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    entries: BatchIdempotencyEntry[]
  ): void {
    if (entries.length === 0) {
      return
    }

    tx.insert(idempotencyKeyBatchesTable)
      .values({
        createdAt: entries[0]?.createdAt ?? Date.now(),
        entries: JSON.stringify(entries),
      })
      .run()
  }

  private writeBatchOutboxFacts(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    facts: OutboxFact[],
    currency: string,
    createdAt: number
  ): void {
    if (facts.length === 0) {
      return
    }

    tx.insert(meterFactsOutboxBatchesTable)
      .values({
        payloads: JSON.stringify(facts),
        currency,
        createdAt,
      })
      .run()
  }

  private async bootstrapReservationSingleFlight(
    input: ApplyInput,
    activeGrants: ActiveGrantInput[],
    meter: MeterIdentity
  ): Promise<ApplyResult | null> {
    const existing = this.reservationBootstrapPromise
    if (existing) {
      const result = await existing
      const window = this.readWalletReservation(this.db)
      return window?.reservationId ? null : result
    }

    const promise = this.bootstrapReservation(input, activeGrants, meter)
    this.reservationBootstrapPromise = promise
    try {
      return await promise
    } finally {
      if (this.reservationBootstrapPromise === promise) {
        this.reservationBootstrapPromise = null
      }
    }
  }

  // Opens the per-(stream, period) reservation lazily on first priced apply().
  // Returns a denial result when the wallet has no available
  // balance to back the reservation; returns `null` on success (or when the
  // feature is free, in which case no reservation is needed).
  //
  // The reservation row is durable: even an allocation of 0 is persisted so
  // subsequent events on this DO short-circuit through the in-tx reservation
  // policy check. The DO may attempt one synchronous grow before returning
  // WALLET_EMPTY when local runway is the only thing short of funding.
  // Customers who want service after running the wallet to 0 must wait for
  // the next period or top up (which clears `purchased` and the next
  // bootstrap on the next period picks it up).
  private async bootstrapReservation(
    input: ApplyInput,
    activeGrants: ActiveGrantInput[],
    meter: MeterIdentity
  ): Promise<ApplyResult | null> {
    const projectedCost = this.computeProjectedCurrentEventCostMinor(input, activeGrants, meter)

    return this.bootstrapReservationForProjectedCost({
      activeGrants,
      input,
      meter,
      projectedCost,
    })
  }

  private async bootstrapReservationForProjectedCost(params: {
    activeGrants: ActiveGrantInput[]
    input: ApplyInput
    meter: MeterIdentity
    projectedCost: number
  }): Promise<ApplyResult | null> {
    const { activeGrants, input, meter, projectedCost } = params

    // The next event lands in a free portion of the curve — flat-free plan,
    // included-quantity tier still has runway, etc. No wallet engagement
    // needed for this event; a later apply() that crosses into a paid tier
    // will re-probe and bootstrap then.
    if (projectedCost <= 0) return null

    const pricePerEvent = Math.max(
      projectedCost,
      computeMaxMarginalPriceMinor(input.entitlement.featureConfig)
    )
    const policy = this.reservationPolicy()
    const sizing = computeInitialReservation({
      pricePerEventAmount: pricePerEvent,
      currentEventCostAmount: projectedCost,
      policy,
    })
    if (sizing.requestedAmount <= 0) return null

    const walletService = this.getWalletService()
    const reservationGrant = this.firstGrantByDrainOrder(activeGrants)
    const reservationBucket = computeGrantPeriodBucket(reservationGrant, input.event.timestamp)
    const durableObjectId = this.ctx.id.toString()
    const sampledAtMs = Date.now()

    if (!reservationBucket) {
      throw new Error("Unable to resolve grant bucket for reservation bootstrap")
    }

    const reservationIdempotencyKey = `do_lazy:${meter.customerEntitlementId}:${reservationBucket.periodKey}`

    const result = await walletService.createReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: meter.currency as Currency,
      entitlementId: input.entitlement.customerEntitlementId,
      requestedAmount: sizing.requestedAmount,
      refillThresholdBps: policy.refillThresholdBps,
      refillChunkAmount: 0,
      periodStartAt: new Date(reservationBucket.start),
      periodEndAt: new Date(reservationBucket.end),
      effectiveAt: new Date(input.event.timestamp),
      metadata: {
        requestedBy: "durable_object",
        requestedById: durableObjectId,
        durableObjectId,
        meterKey: meter.key,
        customerEntitlementId: input.entitlement.customerEntitlementId,
        featureSlug: input.entitlement.featureSlug,
        eventSlug: meter.config.eventSlug,
        idempotencyKey: reservationIdempotencyKey,
      },
      // The (project, entitlement, period_start) unique index is the real
      // dedupe — this key just tags ledger entries for traceability.
      idempotencyKey: reservationIdempotencyKey,
    })

    if (result.err) {
      this.logger.error(result.err, {
        context: "lazy reservation bootstrap failed",
        customer_id: input.customerId,
        project_id: input.projectId,
        customer_entitlement_id: input.entitlement.customerEntitlementId,
        reservation_idempotency_key: reservationIdempotencyKey,
        requested_amount: sizing.requestedAmount,
        projected_cost_minor: projectedCost,
      })
      throw result.err
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
            refillThresholdBps: policy.refillThresholdBps,
            refillChunkAmount: 0,
            targetReservationAmount: sizing.targetReservationAmount,
            spendEwmaAmount: 0,
            lastRateSampledAtMs: sampledAtMs,
            maxEventCostAmount: projectedCost,
          }
        : {
            reservationId: result.val.reservationId,
            allocationAmount: result.val.allocationAmount,
            consumedAmount: 0,
            flushedAmount: 0,
            flushSeq: 0,
            pendingFlushSeq: null,
            pendingFlushFinal: false,
            pendingFlushAmount: null,
            pendingRefillAmount: 0,
            refillThresholdBps: policy.refillThresholdBps,
            refillChunkAmount: 0,
            targetReservationAmount: sizing.targetReservationAmount,
            spendEwmaAmount: 0,
            lastRateSampledAtMs: sampledAtMs,
            maxEventCostAmount: projectedCost,
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

  private computeProjectedCurrentEventCostMinor(
    input: ApplyInput,
    activeGrants: ActiveGrantInput[],
    meter: MeterIdentity
  ): number {
    const fact = this.projectFactForCurrentEvent(input, meter)
    if (!fact) return 0

    return this.priceProjectedFact({
      activeGrants,
      entitlement: input.entitlement,
      eventTimestamp: input.event.timestamp,
      fact,
    })
  }

  private computeProjectedBatchEventCostMinor(params: {
    activeGrants: ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    event: ApplyInput["event"]
    eventTimestamp: number
    grantStates: GrantConsumptionState[]
    meter: MeterIdentity
    meterState: MeterStateDraft
  }): number {
    const projectedMeterState: MeterStateDraft = { ...params.meterState }
    const adapter = new InMemoryMeterStorageAdapter(projectedMeterState)
    const engine = new AsyncMeterAggregationEngine([params.meter.config], adapter, Date.now())
    const facts = engine.applyEventSync(params.event)
    if (facts.length === 0) {
      return 0
    }

    const projectedGrantStates = params.grantStates.map((state) => ({ ...state }))
    const { pricedFacts } = this.priceFactsFromGrantStates({
      activeGrants: params.activeGrants,
      entitlement: params.entitlement,
      eventTimestamp: params.eventTimestamp,
      facts,
      grantStates: projectedGrantStates,
    })

    return pricedFacts.reduce((sum, fact) => sum + fact.amountMinor, 0)
  }

  private projectFactForCurrentEvent(input: ApplyInput, meter: MeterIdentity): Fact | null {
    if (meter.config.eventSlug !== input.event.slug) {
      return null
    }

    const row = this.db
      .select({ usage: meterStateTable.usage, updatedAt: meterStateTable.updatedAt })
      .from(meterStateTable)
      .where(eq(meterStateTable.meterKey, meter.key))
      .get()

    const previousValue = Number(row?.usage ?? 0)
    const previousUpdatedAt =
      row?.updatedAt === null || row?.updatedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Number(row.updatedAt)

    switch (meter.config.aggregationMethod) {
      case "count": {
        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: 1,
          valueAfter: previousValue + 1,
        }
      }
      case "sum": {
        const numericValue = this.readNumericEventField(meter.config, input.event)
        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: numericValue,
          valueAfter: previousValue + numericValue,
        }
      }
      case "max": {
        const numericValue = this.readNumericEventField(meter.config, input.event)
        const nextValue = row ? Math.max(previousValue, numericValue) : numericValue
        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: nextValue - previousValue,
          valueAfter: nextValue,
        }
      }
      case "latest": {
        const numericValue = this.readNumericEventField(meter.config, input.event)
        if (input.event.timestamp < previousUpdatedAt) {
          return {
            eventId: input.event.id,
            meterKey: meter.key,
            delta: 0,
            valueAfter: previousValue,
          }
        }

        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: numericValue - previousValue,
          valueAfter: numericValue,
        }
      }
      default:
        return null
    }
  }

  private priceProjectedFact(params: {
    activeGrants: ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    eventTimestamp: number
    fact: Fact
  }): number {
    const priceGrant = this.firstGrantByDrainOrder(params.activeGrants)
    const { fact } = params

    if (fact.delta <= 0) {
      const usageAfter = Math.max(0, fact.valueAfter)
      const usageBefore = Math.max(0, fact.valueAfter - fact.delta)
      return computeUsagePriceDeltaMinor({
        priceConfig: params.entitlement.featureConfig,
        usageAfter,
        usageBefore,
      })
    }

    const consumed = consumeGrantsByPriority({
      grants: params.activeGrants,
      states: this.readGrantStatesForActiveGrants(
        this.db,
        params.activeGrants,
        params.eventTimestamp
      ),
      timestamp: params.eventTimestamp,
      units: fact.delta,
    })

    let total = 0
    for (const allocation of consumed.allocations) {
      total += computeUsagePriceDeltaMinor({
        priceConfig: params.entitlement.featureConfig,
        usageAfter: allocation.usageAfter,
        usageBefore: allocation.usageBefore,
      })
    }

    if (consumed.remaining > 0 && priceGrant) {
      const usageAfter = Math.max(0, fact.valueAfter)
      const usageBefore = Math.max(0, fact.valueAfter - fact.delta)
      total += computeUsagePriceDeltaMinor({
        priceConfig: params.entitlement.featureConfig,
        usageAfter,
        usageBefore,
      })
    }

    return total
  }

  private readNumericEventField(meterConfig: MeterConfig, event: ApplyInput["event"]): number {
    const field = meterConfig.aggregationField

    if (!field) {
      throw new Error(`Meter ${meterConfig.eventId} requires an aggregation field`)
    }

    const rawValue = event.properties[field]
    const numericValue = this.parseFiniteNumericValue(rawValue)

    if (numericValue === null) {
      throw new Error(
        `Meter ${meterConfig.eventId} requires a finite numeric value at properties.${field}`
      )
    }

    return numericValue
  }

  private parseFiniteNumericValue(value: unknown): number | null {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null
    }

    if (typeof value !== "string") {
      return null
    }

    const trimmedValue = value.trim()
    if (trimmedValue.length === 0) {
      return null
    }

    const parsedValue = Number(trimmedValue)
    return Number.isFinite(parsedValue) ? parsedValue : null
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

  private async flushBatchOutboxToTinybird(batch: OutboxBatchFlushRow[]): Promise<boolean> {
    let facts: AnalyticsEntitlementMeterFact[]

    try {
      facts = batch.flatMap((row) => {
        const payloads = z.array(outboxFactSchema).parse(JSON.parse(row.payloads))
        return payloads.map((payload) => entitlementMeterFactSchemaV1.parse(payload))
      })
    } catch (error) {
      this.logger.error(error, {
        context: "Failed to parse compact entitlement meter fact outbox payload",
        batchSize: batch.length,
      })
      return false
    }

    if (facts.length === 0) {
      return true
    }

    try {
      const result = await this.analytics.ingestEntitlementMeterFacts(facts)
      const successful = result?.successful_rows ?? 0
      const quarantined = result?.quarantined_rows ?? 0

      if (successful === facts.length && quarantined === 0) {
        return true
      }

      this.logger.error("Tinybird compact entitlement meter facts ingestion failed", {
        expected: facts.length,
        successful,
        quarantined,
      })
    } catch (error) {
      this.logger.error(error, {
        context: "Failed to ingest compact entitlement meter facts to Tinybird",
        batchSize: facts.length,
      })
    }

    return false
  }

  private shouldRunIdempotencyCleanup(now: number): boolean {
    return (
      this.lastIdempotencyCleanupAt === null ||
      now - this.lastIdempotencyCleanupAt >= IDEMPOTENCY_CLEANUP_INTERVAL_MS
    )
  }

  private cleanupStaleIdempotencyKeys(now: number): number {
    const staleIdempotencyCutoff = now - DO_IDEMPOTENCY_TTL_MS
    const staleBatchRows = this.db
      .select({ id: idempotencyKeyBatchesTable.id })
      .from(idempotencyKeyBatchesTable)
      .where(lt(idempotencyKeyBatchesTable.createdAt, staleIdempotencyCutoff))
      .orderBy(asc(idempotencyKeyBatchesTable.createdAt))
      .limit(IDEMPOTENCY_CLEANUP_BATCH_SIZE)
      .all()

    if (staleBatchRows.length > 0) {
      this.db
        .delete(idempotencyKeyBatchesTable)
        .where(
          inArray(
            idempotencyKeyBatchesTable.id,
            staleBatchRows.map((row) => row.id)
          )
        )
        .run()
      this.batchIdempotencyResults = null
    }

    return staleBatchRows.length
  }

  private getOutboxCount(): number {
    const batchOutboxCount = this.db
      .select({ id: meterFactsOutboxBatchesTable.id })
      .from(meterFactsOutboxBatchesTable)
      .orderBy(asc(meterFactsOutboxBatchesTable.id))
      .limit(OUTBOX_DEPTH_ALERT_THRESHOLD + 1)
      .all().length

    return batchOutboxCount
  }

  private async scheduleAlarm(target: number): Promise<void> {
    const now = Date.now()
    if (this.nextAlarmAt !== null && this.nextAlarmAt > now && this.nextAlarmAt <= target) {
      return
    }

    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null && existing > now && existing <= target) {
      this.nextAlarmAt = existing
      return
    }
    await this.ctx.storage.setAlarm(target)
    this.nextAlarmAt = target
  }

  private async scheduleAlarmCoalesced(target: number): Promise<void> {
    const now = Date.now()
    if (this.nextAlarmAt !== null && this.nextAlarmAt > now && this.nextAlarmAt <= target) {
      return
    }

    await this.ctx.storage.setAlarm(target)
    this.nextAlarmAt = target
  }
}
