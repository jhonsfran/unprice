import { DurableObject } from "cloudflare:workers"
import { createConnection } from "@unprice/db"
import type {
  ConfigFeatureVersionType,
  Currency,
  OverageStrategy,
  ResetConfig,
} from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { LEDGER_SCALE, formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
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
  computeUsagePriceDeltaExplanation,
  computeUsagePriceDeltaMinor,
  consumeGrantsByPriority,
  resolveActiveGrants,
  resolveAvailableGrantUnits,
  resolveConsumedGrantUnits,
} from "@unprice/services/entitlements"
import { LedgerGateway } from "@unprice/services/ledger"
import {
  type CreateReservationOutput,
  type ReservationCloseReason,
  WalletService,
} from "@unprice/services/wallet"
import {
  DEFAULT_RESERVATION_POLICY,
  type InitialReservationDecision,
  type ReservationPolicy,
  computeInitialReservation,
  computeRefillDecision,
  computeSyncGrowRefillAmount,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import { asc, desc, eq, inArray, lt } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import { createDoLogger, runDoOperation } from "~/observability"
import {
  buildBatchEventApplyInput,
  computeBatchReservationHeadroom,
  computeBatchReservationRefillAmount,
  createAllowedBatchOutcome,
  createCachedBatchResult,
  createDeniedBatchOutcome,
  hasStagedBatchMutations,
  idempotencyEntryToApplyResult,
  planWalletReservationSpend,
  stageBatchIdempotencyEntry,
} from "./batch-apply-helpers"
import {
  APPLY_BATCH_SIZE_LIMIT,
  FLUSH_INTERVAL_MS,
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  WALLET_RESERVATION_ROW_ID,
} from "./constants"
import {
  type ActiveGrantInput,
  type ApplyBatchInput,
  type ApplyBatchInternalResult,
  type ApplyBatchMetrics,
  type ApplyBatchResultRow,
  type ApplyGrantInput,
  type ApplyInnerOptions,
  type ApplyInput,
  type ApplyResult,
  type BatchIdempotencyEntry,
  type CloseReservationOptions,
  type CloseReservationResult,
  type DeniedReason,
  type EnforcementStateCache,
  type EnforcementStateInput,
  type EnforcementStateResult,
  type EntitlementApplyMeterFact,
  type EntitlementConfigInput,
  type EntitlementCreditLinePolicy,
  EntitlementWindowBatchReservationBootstrapRequired,
  EntitlementWindowBatchReservationUnderfundedError,
  EntitlementWindowLimitExceededError,
  EntitlementWindowReservationUnderfundedError,
  type EntitlementWindowStatus,
  EntitlementWindowWalletEmptyError,
  type FlushReservationForInvoicingInput,
  type FlushReservationForInvoicingResult,
  type MeterIdentity,
  type PricedFact,
  type RefillTrigger,
  type ReservationGrowthResult,
  type WalletReservationSnapshot,
  applyBatchInputSchema,
  applyInputSchema,
  batchIdempotencyEntryListSchema,
  compactGrantConsumptionStateListSchema,
  createApplyBatchMetrics,
  enforcementStateInputSchema,
} from "./contracts"
import {
  entitlementConfigTable,
  entitlementPeriodUsageTable,
  grantsTable,
  idempotencyKeyBatchesTable,
  meterStateTable,
  schema,
  walletReservationTable,
} from "./db/schema"
import migrations from "./drizzle/migrations"
import {
  extractCurrencyCodeFromFeatureConfig,
  readNumericEventField,
  resolveMeterIdentity,
} from "./meter-helpers"
import { InMemoryMeterStorageAdapter, type MeterStateDraft } from "./meter-state-adapter"
import {
  inactivityThresholdMs,
  jsonEquals,
  maxFlushIntervalMs,
  minNullableExpiry,
  unique,
} from "./utils"

export { entitlementWindowStatusSchema } from "./contracts"
export type { EntitlementWindowStatus } from "./contracts"

type OptimizedBatchWriteMetrics = Pick<
  ApplyBatchMetrics,
  | "grant_window_write_count"
  | "idempotency_event_count"
  | "idempotency_insert_count"
  | "meter_state_write_count"
  | "outbox_fact_count"
  | "outbox_insert_count"
  | "wallet_reservation_write_count"
>

type OptimizedBatchSetup = {
  cachedResults: Map<string, BatchIdempotencyEntry>
  entitlement: EntitlementConfigInput
  grants: ActiveGrantInput[]
  grantStates: GrantConsumptionState[]
  meter: MeterIdentity
  meterState: MeterStateDraft
  wallet: WalletReservationSnapshot
}

type OptimizedBatchProcessingState = {
  grantStates: GrantConsumptionState[]
  idempotencyEntries: BatchIdempotencyEntry[]
  meterState: MeterStateDraft
  metrics: ApplyBatchMetrics
  refillTrigger: RefillTrigger | null
  reservationCloseReason: ReservationCloseReason | null
  results: ApplyBatchResultRow[]
  stagedResultsByKey: Map<string, BatchIdempotencyEntry>
  touchedGrantStates: Map<string, GrantConsumptionState>
  wallet: WalletReservationSnapshot
  walletDirty: boolean
}

type OptimizedBatchOptions = {
  refillAttemptedEventIds: ReadonlySet<string>
  walletDiagnostics?: OptimizedBatchWalletDiagnostics
}

type OptimizedBatchWalletRetryOutcome =
  | "already_funded"
  | "refilled"
  | "max_outstanding_reached"
  | "unavailable"

type BatchReservationGrowthResult = ReservationGrowthResult | { kind: "max_outstanding_reached" }

type OptimizedBatchWalletDiagnostics = {
  emptyAfterRefillEventIds: string[]
  emptyAfterRefillLastRemainingAmount: number | null
  emptyAfterRefillLastRequiredAmount: number | null
  retryCount: number
  retryEventIds: string[]
  retryLastCurrentRemainingAmount: number | null
  retryLastEffectiveCostAmount: number | null
  retryLastMeterKey: string | null
  retryLastMeterSlug: string | null
  retryLastPersistedConsumedAmount: number | null
  retryLastRequiredHeadroomAmount: number | null
  retryLastReservationId: string | null
  retryLastStagedConsumedAmount: number | null
  retryOutcomes: OptimizedBatchWalletRetryOutcome[]
}

function createOptimizedBatchProcessingState(
  setup: OptimizedBatchSetup
): OptimizedBatchProcessingState {
  return {
    grantStates: setup.grantStates.map((state) => ({ ...state })),
    idempotencyEntries: [],
    meterState: { ...setup.meterState },
    metrics: createApplyBatchMetrics(),
    refillTrigger: null,
    reservationCloseReason: null,
    results: [],
    stagedResultsByKey: new Map<string, BatchIdempotencyEntry>(),
    touchedGrantStates: new Map<string, GrantConsumptionState>(),
    wallet: setup.wallet ? { ...setup.wallet } : null,
    walletDirty: false,
  }
}

function createOptimizedBatchWalletDiagnostics(): OptimizedBatchWalletDiagnostics {
  return {
    emptyAfterRefillEventIds: [],
    emptyAfterRefillLastRemainingAmount: null,
    emptyAfterRefillLastRequiredAmount: null,
    retryCount: 0,
    retryEventIds: [],
    retryLastCurrentRemainingAmount: null,
    retryLastEffectiveCostAmount: null,
    retryLastMeterKey: null,
    retryLastMeterSlug: null,
    retryLastPersistedConsumedAmount: null,
    retryLastRequiredHeadroomAmount: null,
    retryLastReservationId: null,
    retryLastStagedConsumedAmount: null,
    retryOutcomes: [],
  }
}

function batchWalletDiagnosticsLogFields(
  diagnostics: OptimizedBatchWalletDiagnostics,
  currency: string | null
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    batch_wallet_underfunded_retry_count: diagnostics.retryCount,
    batch_wallet_underfunded_event_ids: diagnostics.retryEventIds,
    batch_wallet_underfunded_refill_outcomes: diagnostics.retryOutcomes,
    batch_wallet_underfunded_last_event_id:
      diagnostics.retryEventIds[diagnostics.retryEventIds.length - 1] ?? null,
    batch_wallet_underfunded_last_meter_key: diagnostics.retryLastMeterKey,
    batch_wallet_underfunded_last_meter_slug: diagnostics.retryLastMeterSlug,
    batch_wallet_underfunded_last_reservation_id: diagnostics.retryLastReservationId,
    batch_wallet_underfunded_last_persisted_consumed_amount:
      diagnostics.retryLastPersistedConsumedAmount,
    batch_wallet_underfunded_last_staged_consumed_amount: diagnostics.retryLastStagedConsumedAmount,
    batch_wallet_underfunded_last_effective_cost_amount: diagnostics.retryLastEffectiveCostAmount,
    batch_wallet_underfunded_last_required_headroom_amount:
      diagnostics.retryLastRequiredHeadroomAmount,
    batch_wallet_underfunded_last_remaining_amount: diagnostics.retryLastCurrentRemainingAmount,
    batch_wallet_empty_after_refill_count: diagnostics.emptyAfterRefillEventIds.length,
    batch_wallet_empty_after_refill_event_ids: diagnostics.emptyAfterRefillEventIds,
    batch_wallet_empty_after_refill_last_event_id:
      diagnostics.emptyAfterRefillEventIds[diagnostics.emptyAfterRefillEventIds.length - 1] ?? null,
    batch_wallet_empty_after_refill_last_required_amount:
      diagnostics.emptyAfterRefillLastRequiredAmount,
    batch_wallet_empty_after_refill_last_remaining_amount:
      diagnostics.emptyAfterRefillLastRemainingAmount,
  }

  addLedgerAmountDisplayFields(fields, currency, [
    "batch_wallet_underfunded_last_persisted_consumed_amount",
    "batch_wallet_underfunded_last_staged_consumed_amount",
    "batch_wallet_underfunded_last_effective_cost_amount",
    "batch_wallet_underfunded_last_required_headroom_amount",
    "batch_wallet_underfunded_last_remaining_amount",
    "batch_wallet_empty_after_refill_last_required_amount",
    "batch_wallet_empty_after_refill_last_remaining_amount",
  ])

  return fields
}

function addLedgerAmountDisplayFields(
  fields: Record<string, unknown>,
  currency: string | null | undefined,
  amountFieldNames: string[]
): void {
  for (const fieldName of amountFieldNames) {
    const display = formatLedgerMinorForLog(fields[fieldName], currency)
    if (display !== null) {
      fields[`${fieldName}_display`] = display
    }
  }
}

function formatLedgerMinorForLog(
  value: unknown,
  currency: string | null | undefined
): string | null {
  if (!currency || typeof value !== "number" || !Number.isFinite(value)) {
    return null
  }

  try {
    return toDecimal(fromLedgerMinor(value, currency), ({ value: amount, currency: resolved }) =>
      formatMoney(amount, resolved.code)
    )
  } catch {
    return null
  }
}

function readLogCurrency(fields: Record<string, unknown>): string | null {
  const currency = fields.currency
  return typeof currency === "string" && currency.length > 0 ? currency : null
}

function recordBatchWalletUnderfundedRetry(params: {
  diagnostics: OptimizedBatchWalletDiagnostics
  error: EntitlementWindowBatchReservationUnderfundedError
  outcome: OptimizedBatchWalletRetryOutcome
}): void {
  const { diagnostics, error, outcome } = params
  const headroom = computeBatchReservationHeadroom({
    persistedConsumedAmount: error.params.persistedConsumedAmount,
    stagedConsumedAmount: error.params.stagedConsumedAmount,
    currentEventEffectiveCostAmount: error.params.effectiveCostAmount,
  })

  diagnostics.retryCount++
  diagnostics.retryEventIds.push(error.params.eventId)
  diagnostics.retryOutcomes.push(outcome)
  diagnostics.retryLastCurrentRemainingAmount = error.params.currentRemainingAmount
  diagnostics.retryLastEffectiveCostAmount = error.params.effectiveCostAmount
  diagnostics.retryLastMeterKey = error.params.meterKey
  diagnostics.retryLastMeterSlug = error.params.meterSlug
  diagnostics.retryLastPersistedConsumedAmount = error.params.persistedConsumedAmount
  diagnostics.retryLastRequiredHeadroomAmount = headroom.requiredHeadroomAmount
  diagnostics.retryLastReservationId = error.params.reservationId
  diagnostics.retryLastStagedConsumedAmount = error.params.stagedConsumedAmount
}

type SingleApplyExecutionMetrics = {
  duplicateCount: number
  grantAllocationCount: number
  grantWindowWriteCount: number
  idempotencyInsertCount: number
  insertedFactCount: number
  meterStateWriteCount: number
  outboxFactCount: number
  outboxInsertCount: number
  pricedFactCount: number
  refillTrigger: RefillTrigger | null
  reservationEngaged: boolean
  totalCost: number
  walletReservationWriteCount: number
}

type SingleApplyContext = {
  activeGrants: ActiveGrantInput[]
  creditLinePolicy: EntitlementCreditLinePolicy
  entitlement: EntitlementConfigInput
  meter: MeterIdentity
  overageStrategy: OverageStrategy
}

type SingleApplyBootstrapOutcome = {
  result: ApplyResult | null
  usesWalletReservation: boolean
}

type SingleApplyErrorRecovery =
  | { kind: "retry"; synchronousRefillAttempted: boolean }
  | { kind: "done"; result: ApplyResult; synchronousRefillAttempted: boolean }

type SingleApplyWalletSpendOutcome = {
  lastEventAtStamped: boolean
  window: WalletReservationSnapshot
}

type ReservationCloseFlushIntent = {
  nextSeq: number
  unflushed: number
  unflushedQuantity: number
}

type ReservationCloseCaptureOutcome =
  | { kind: "captured"; capturedAmount: number; capturedQuantity: number }
  | { kind: "done"; result: CloseReservationResult }

type ReservationCloseReleaseOutcome =
  | {
      kind: "released"
      refundedPurchasedAmount: number
      releasedAmount: number
      restoredGrantedAmount: number
    }
  | { kind: "done"; result: CloseReservationResult }

type ReservationBootstrapPlan = {
  bucket: NonNullable<ReturnType<typeof computeGrantPeriodBucket>>
  idempotencyKey: string
  policy: ReservationPolicy
  sampledAtMs: number
  sizing: InitialReservationDecision
}

type ReservationInvoiceContext = {
  billingPeriodId: string
  cycleEndAt: number
  cycleStartAt: number
  featurePlanVersionItemId: string
  featureSlug: string
  sourceId: string
  statementKey: string
}

function createSingleApplyExecutionMetrics(): SingleApplyExecutionMetrics {
  return {
    duplicateCount: 0,
    grantAllocationCount: 0,
    grantWindowWriteCount: 0,
    idempotencyInsertCount: 0,
    insertedFactCount: 0,
    meterStateWriteCount: 0,
    outboxFactCount: 0,
    outboxInsertCount: 0,
    pricedFactCount: 0,
    refillTrigger: null,
    reservationEngaged: false,
    totalCost: 0,
    walletReservationWriteCount: 0,
  }
}

type OpenWalletReservationSnapshot = NonNullable<WalletReservationSnapshot> & {
  reservationId: string
}
type IdentifiedWalletReservationSnapshot = OpenWalletReservationSnapshot & {
  customerId: string
  projectId: string
}
type ClosableWalletReservationSnapshot = IdentifiedWalletReservationSnapshot

type ReservationGrowthReadiness =
  | { kind: "ready"; currentRemaining: number; window: IdentifiedWalletReservationSnapshot }
  | { kind: "already_funded" }
  | { kind: "unavailable" }

type ReservationGrowthPlan = {
  refillDecision: ReturnType<typeof computeRefillDecision>
  spendVelocity: {
    lastRateSampledAtMs: number | null
    spendEwmaAmount: number
  }
  trigger: RefillTrigger
}

type AlarmReservationCloseTrigger = {
  closeReason: ReservationCloseReason
  isDeletionPending: boolean
}

export class EntitlementWindowDO extends DurableObject {
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

    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
      this.hydrateBatchIdempotencyResults()
      this.nextAlarmAt = await this.ctx.storage.getAlarm()

      // Crash recovery. If the DO was evicted mid-flush, the SQLite row still
      // carries `pending_flush_seq > flush_seq`. Re-issue the flush with the
      // same seq — WalletService dedupes via the ledger
      // idempotency key `flush:{reservationId}:{flushSeq}`, so a duplicate
      // call after a successful commit is a no-op. Newer events accepted
      // after the pending seq was created must wait for the next seq, so
      // replays use the persisted pending amount and quantity.
      const window = this.readWalletReservation(this.db)
      if (
        window?.reservationId &&
        !window.recoveryRequired &&
        !window.deletionRequested &&
        window.pendingFlushSeq !== null &&
        window.pendingFlushSeq !== undefined &&
        window.pendingFlushSeq > window.flushSeq
      ) {
        if (window.pendingFlushAmount === null || window.pendingFlushQuantity === null) {
          throw new Error(
            `Wallet reservation ${window.reservationId} is missing pending flush metadata`
          )
        }
        const flushAmount = window.pendingFlushAmount
        const flushQuantity = window.pendingFlushQuantity
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
              flushQuantity,
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
        const walletDiagnostics = createOptimizedBatchWalletDiagnostics()
        const currency = extractCurrencyCodeFromFeatureConfig(input.entitlement.featureConfig)
        let reservationAction: "none" | "refilled" | "bootstrapped" = "none"
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
            if (error instanceof EntitlementWindowBatchReservationBootstrapRequired) {
              const eventInput = buildBatchEventApplyInput(input, error.params.event)
              const setup = this.prepareOptimizedBatch(
                input,
                Date.now(),
                unique(input.events.map((event) => event.idempotencyKey))
              )
              const activeGrants = resolveActiveGrants(setup.grants, error.params.event.timestamp)
              const denial = await this.bootstrapReservationForProjectedCost({
                activeGrants,
                input: eventInput,
                meter: setup.meter,
                projectedCost: error.params.projectedCost,
              })

              if (denial) {
                throw new Error(`Batch reservation bootstrap denied: ${denial.deniedReason}`)
              }

              reservationAction = "bootstrapped"
              const retry = await this.applyBatchOptimized(input)
              metrics = retry.metrics
              results.push(...retry.results)
              return { results: retry.results }
            }

            if (error instanceof EntitlementWindowBatchReservationUnderfundedError) {
              const refillAttemptedEventIds = new Set<string>()
              let underfundedError = error

              for (let attempt = 0; attempt < input.events.length; attempt++) {
                const growth = await this.growReservationForBatchHeadroom(underfundedError.params)
                const growthOutcome = growth?.kind ?? "unavailable"
                recordBatchWalletUnderfundedRetry({
                  diagnostics: walletDiagnostics,
                  error: underfundedError,
                  outcome: growthOutcome,
                })
                if (
                  growth?.kind !== "refilled" &&
                  growth?.kind !== "already_funded" &&
                  growth?.kind !== "max_outstanding_reached"
                ) {
                  throw underfundedError
                }

                if (growth.kind === "refilled") {
                  reservationAction = "refilled"
                }

                if (growth.kind === "refilled" || growth.kind === "max_outstanding_reached") {
                  refillAttemptedEventIds.add(underfundedError.params.eventId)
                }

                try {
                  const retry = await this.applyBatchOptimized(input, {
                    refillAttemptedEventIds,
                    walletDiagnostics,
                  })
                  metrics = retry.metrics
                  results.push(...retry.results)
                  return { results: retry.results }
                } catch (retryError) {
                  if (!(retryError instanceof EntitlementWindowBatchReservationUnderfundedError)) {
                    throw retryError
                  }
                  underfundedError = retryError
                }
              }

              throw underfundedError
            }

            throw error
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

          const batchEvent = {
            operation: "apply_batch",
            project_id: input.projectId,
            customer_id: input.customerId,
            customer_entitlement_id: input.entitlement.customerEntitlementId,
            currency,
            event_count: input.events.length,
            reservation_action: reservationAction,
            processed_count: results.length,
            allowed_count: results.filter((result) => result.allowed).length,
            denied_count: results.filter((result) => !result.allowed).length,
            ...metrics,
            ...batchWalletDiagnosticsLogFields(walletDiagnostics, currency),
            denied_by_reason: deniedByReason,
            duration_ms: Date.now() - startTime,
            outcome: thrown ? "error" : "success",
            error_type: thrown instanceof Error ? thrown.name : undefined,
            error_message: thrown instanceof Error ? thrown.message : undefined,
          }

          this.logger.info("entitlement apply_batch", batchEvent)
        }
      }
    )
  }

  private prepareOptimizedBatch(
    input: ApplyBatchInput,
    createdAt: number,
    idempotencyKeys: string[]
  ): OptimizedBatchSetup {
    return this.db.transaction((tx) => {
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
      const meter = resolveMeterIdentity(entitlement)

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
  }

  private async applyBatchOptimized(
    input: ApplyBatchInput,
    options: OptimizedBatchOptions = { refillAttemptedEventIds: new Set() }
  ): Promise<ApplyBatchInternalResult> {
    const createdAt = Date.now()
    const idempotencyKeys = unique(input.events.map((event) => event.idempotencyKey))
    const setup = this.prepareOptimizedBatch(input, createdAt, idempotencyKeys)
    const state = createOptimizedBatchProcessingState(setup)

    for (const event of input.events) {
      await this.processOptimizedBatchEvent({
        createdAt,
        event,
        input,
        options,
        setup,
        state,
      })
    }

    Object.assign(
      state.metrics,
      this.commitOptimizedBatch({
        createdAt,
        idempotencyEntries: state.idempotencyEntries,
        meter: setup.meter,
        meterState: state.meterState,
        touchedGrantStates: state.touchedGrantStates,
        wallet: state.wallet,
        walletDirty: state.walletDirty,
      })
    )

    if (state.refillTrigger) {
      this.ctx.waitUntil(this.requestFlushAndRefill(state.refillTrigger))
    }

    if (state.reservationCloseReason) {
      this.ctx.waitUntil(this.closeReservation({ closeReason: state.reservationCloseReason }))
    }

    return { results: state.results, metrics: state.metrics }
  }

  private async processOptimizedBatchEvent(params: {
    createdAt: number
    event: ApplyBatchInput["events"][number]
    input: ApplyBatchInput
    options: OptimizedBatchOptions
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
  }): Promise<void> {
    const { createdAt, event, input, options, setup, state } = params
    const activeGrants = resolveActiveGrants(setup.grants, event.timestamp)

    if (activeGrants.length === 0) {
      throw new Error("No active grants found for event timestamp")
    }

    const cached =
      state.stagedResultsByKey.get(event.idempotencyKey) ??
      setup.cachedResults.get(event.idempotencyKey)
    if (cached) {
      state.metrics.duplicate_count++
      state.results.push(
        createCachedBatchResult({
          entry: cached,
          correlationKey: event.correlationKey,
          idempotencyKey: event.idempotencyKey,
        })
      )
      return
    }

    const lateClosedPeriod = this.resolveLateClosedPeriod({
      activeGrants,
      eventTimestamp: event.timestamp,
      now: event.now,
    })

    if (lateClosedPeriod) {
      this.stageOptimizedBatchDeniedResult({
        createdAt,
        deniedReason: "LATE_EVENT_CLOSED_PERIOD",
        message: `Event timestamp is ${lateClosedPeriod.lagMs}ms after the closed period grace window`,
        event,
        state,
      })
      return
    }

    const eventInput = buildBatchEventApplyInput(input, event)
    const usesWalletReservation = input.entitlement.creditLinePolicy !== "uncapped"
    if (usesWalletReservation && state.wallet?.reservationId) {
      state.wallet = this.refreshWalletReservationInvoiceContextIfMissing(
        this.db,
        eventInput,
        state.wallet
      )
    }

    const bootstrapHandled = await this.ensureOptimizedBatchWalletBootstrap({
      activeGrants,
      createdAt,
      event,
      eventInput,
      setup,
      state,
      usesWalletReservation,
    })
    if (bootstrapHandled) {
      return
    }

    const walletHeadroomHandled = this.ensureOptimizedBatchWalletHeadroom({
      activeGrants,
      createdAt,
      diagnostics: options.walletDiagnostics,
      event,
      eventInput,
      refillAttempted: options.refillAttemptedEventIds.has(event.id),
      setup,
      state,
      usesWalletReservation,
    })
    if (walletHeadroomHandled) {
      return
    }

    const pricedFacts = this.applyAndPriceOptimizedBatchEvent({
      activeGrants,
      createdAt,
      event,
      eventInput,
      input,
      setup,
      state,
      usesWalletReservation,
    })
    if (!pricedFacts) {
      return
    }

    this.applyOptimizedBatchWalletSpend({
      createdAt,
      event,
      pricedFacts,
      setup,
      state,
      usesWalletReservation,
    })
    this.stageOptimizedBatchAllowedResult({
      createdAt,
      event,
      eventInput,
      pricedFacts,
      setup,
      state,
    })
  }

  private applyAndPriceOptimizedBatchEvent(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    input: ApplyBatchInput
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
    usesWalletReservation: boolean
  }): PricedFact[] | null {
    const {
      activeGrants,
      createdAt,
      event,
      eventInput,
      input,
      setup,
      state,
      usesWalletReservation,
    } = params
    let facts: Fact[]
    try {
      facts = this.applyOptimizedBatchMeterEvent({
        activeGrants,
        event,
        eventInput,
        input,
        setup,
        state,
      })
    } catch (error) {
      if (!(error instanceof EntitlementWindowLimitExceededError)) {
        throw error
      }

      if (usesWalletReservation && state.wallet?.reservationId) {
        state.reservationCloseReason = "limit_reached"
      }

      this.stageOptimizedBatchDeniedResult({
        createdAt,
        deniedReason: "LIMIT_EXCEEDED",
        message: error.message,
        event,
        state,
      })
      return null
    }

    const { pricedFacts, touchedStates } = this.priceFactsFromGrantStates({
      activeGrants,
      entitlement: setup.entitlement,
      eventTimestamp: event.timestamp,
      facts,
      grantStates: state.grantStates,
    })
    state.metrics.priced_fact_count += pricedFacts.length
    state.metrics.grant_allocation_count += touchedStates.size

    for (const [bucketKey, grantState] of touchedStates.entries()) {
      state.touchedGrantStates.set(bucketKey, grantState)
    }

    return pricedFacts
  }

  private stageOptimizedBatchAllowedResult(params: {
    createdAt: number
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    pricedFacts: PricedFact[]
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
  }): void {
    const { createdAt, event, eventInput, pricedFacts, setup, state } = params
    const meterFacts = pricedFacts.map((pricedFact) =>
      this.buildMeterFactPayload({
        createdAt,
        input: eventInput,
        meter: setup.meter,
        pricedFact,
      })
    )

    const allowed = createAllowedBatchOutcome({
      correlationKey: event.correlationKey,
      createdAt,
      idempotencyKey: event.idempotencyKey,
      meterFacts,
    })
    stageBatchIdempotencyEntry({
      entries: state.idempotencyEntries,
      entry: allowed.entry,
      stagedResultsByKey: state.stagedResultsByKey,
    })
    state.results.push(allowed.result)
  }

  private async ensureOptimizedBatchWalletBootstrap(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
    usesWalletReservation: boolean
  }): Promise<boolean> {
    const { activeGrants, createdAt, event, eventInput, setup, state, usesWalletReservation } =
      params
    const needsBootstrap =
      usesWalletReservation && (!state.wallet || state.wallet.reservationId === null)

    if (!needsBootstrap) {
      return false
    }

    if (this.hasOptimizedBatchStagedMutations(state)) {
      const projectedCost = this.computeProjectedBatchEventCostMinor({
        activeGrants,
        entitlement: eventInput.entitlement,
        event: eventInput.event,
        eventTimestamp: event.timestamp,
        grantStates: state.grantStates,
        meter: setup.meter,
        meterState: state.meterState,
      })

      throw new EntitlementWindowBatchReservationBootstrapRequired({
        event,
        projectedCost,
      })
    }

    const projectedCost = this.computeProjectedBatchEventCostMinor({
      activeGrants,
      entitlement: eventInput.entitlement,
      event: eventInput.event,
      eventTimestamp: event.timestamp,
      grantStates: state.grantStates,
      meter: setup.meter,
      meterState: state.meterState,
    })

    if (projectedCost <= 0) {
      return false
    }

    const denial = await this.bootstrapReservationForProjectedCost({
      activeGrants,
      input: eventInput,
      meter: setup.meter,
      projectedCost,
    })

    if (denial) {
      this.stageOptimizedBatchDeniedResult({
        createdAt,
        deniedReason: denial.deniedReason,
        message: denial.message,
        event,
        state,
      })
      return true
    }

    state.wallet = this.readWalletReservation(this.db)
    return false
  }

  private ensureOptimizedBatchWalletHeadroom(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    diagnostics?: OptimizedBatchWalletDiagnostics
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    refillAttempted: boolean
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
    usesWalletReservation: boolean
  }): boolean {
    const {
      activeGrants,
      createdAt,
      diagnostics,
      event,
      eventInput,
      refillAttempted,
      setup,
      state,
      usesWalletReservation,
    } = params
    const wallet = state.wallet

    if (!usesWalletReservation || !wallet?.reservationId || !refillAttempted) {
      return false
    }

    const projectedCost = this.computeProjectedBatchEventCostMinor({
      activeGrants,
      entitlement: eventInput.entitlement,
      event: eventInput.event,
      eventTimestamp: event.timestamp,
      grantStates: state.grantStates,
      meter: setup.meter,
      meterState: state.meterState,
    })
    if (projectedCost <= 0) {
      return false
    }

    const currentRemaining = Math.max(0, wallet.allocationAmount - wallet.consumedAmount)
    if (projectedCost <= currentRemaining) {
      return false
    }

    diagnostics?.emptyAfterRefillEventIds.push(event.id)
    if (diagnostics) {
      diagnostics.emptyAfterRefillLastRemainingAmount = currentRemaining
      diagnostics.emptyAfterRefillLastRequiredAmount = projectedCost
    }

    state.reservationCloseReason = "wallet_empty"
    state.wallet = { ...wallet, lastEventAt: createdAt }
    state.walletDirty = true
    this.stageOptimizedBatchDeniedResult({
      createdAt,
      deniedReason: "WALLET_EMPTY",
      message: `Wallet empty for meter ${setup.meter.config.eventSlug} (reservation ${wallet.reservationId})`,
      event,
      state,
    })
    return true
  }

  private applyOptimizedBatchMeterEvent(params: {
    activeGrants: ActiveGrantInput[]
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    input: ApplyBatchInput
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
  }): Fact[] {
    const { activeGrants, event, eventInput, input, setup, state } = params
    const adapter = new InMemoryMeterStorageAdapter(state.meterState)
    const engine = new AsyncMeterAggregationEngine([setup.meter.config], adapter, event.now)
    return engine.applyEventSync(eventInput.event, {
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
            state.grantStates,
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
  }

  private applyOptimizedBatchWalletSpend(params: {
    createdAt: number
    event: ApplyBatchInput["events"][number]
    pricedFacts: PricedFact[]
    setup: OptimizedBatchSetup
    state: OptimizedBatchProcessingState
    usesWalletReservation: boolean
  }): void {
    const { createdAt, event, pricedFacts, setup, state, usesWalletReservation } = params
    const wallet = state.wallet

    if (usesWalletReservation && wallet?.reservationId && pricedFacts.length > 0) {
      const totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)
      const totalUnits = this.sumPositivePricedFactUnits(pricedFacts)
      const spendPlan = planWalletReservationSpend({
        createdAt,
        entitlement: setup.entitlement,
        eventTimestamp: event.timestamp,
        policy: this.reservationPolicy(),
        totalCost,
        totalUnits,
        window: { ...wallet, reservationId: wallet.reservationId },
      })

      if (spendPlan.kind === "underfunded") {
        const persistedConsumedAmount = setup.wallet?.consumedAmount ?? 0
        throw new EntitlementWindowBatchReservationUnderfundedError({
          eventId: event.id,
          eventTimestamp: event.timestamp,
          meterKey: setup.meter.key,
          meterSlug: setup.meter.config.eventSlug,
          reservationId: wallet.reservationId,
          persistedConsumedAmount,
          stagedConsumedAmount: wallet.consumedAmount,
          effectiveCostAmount: spendPlan.effectiveCostAmount,
          currentRemainingAmount: spendPlan.currentRemaining,
          targetReservationAmount: wallet.targetReservationAmount,
        })
      }

      if (spendPlan.refillStateUpdate) {
        this.requireReservationInvoiceContext(wallet)
      }

      let nextWallet: NonNullable<WalletReservationSnapshot> = {
        ...wallet,
        ...spendPlan.walletStateUpdate,
      }
      state.walletDirty = true

      if (spendPlan.refillStateUpdate) {
        nextWallet = {
          ...nextWallet,
          ...spendPlan.refillStateUpdate,
        }
        state.refillTrigger = spendPlan.refillTrigger
      }

      state.wallet = nextWallet
      return
    }

    if (wallet?.reservationId) {
      state.wallet = { ...wallet, lastEventAt: createdAt }
      state.walletDirty = true
    }
  }

  private hasOptimizedBatchStagedMutations(state: OptimizedBatchProcessingState): boolean {
    return hasStagedBatchMutations({
      idempotencyEntryCount: state.idempotencyEntries.length,
      meterStateDirty: state.meterState.dirty,
      touchedGrantStateCount: state.touchedGrantStates.size,
      walletDirty: state.walletDirty,
    })
  }

  private stageOptimizedBatchDeniedResult(params: {
    createdAt: number
    deniedReason?: DeniedReason
    event: ApplyBatchInput["events"][number]
    message?: string
    state: OptimizedBatchProcessingState
  }): ApplyBatchResultRow {
    const { createdAt, deniedReason, event, message, state } = params
    const denied = createDeniedBatchOutcome({
      correlationKey: event.correlationKey,
      createdAt,
      deniedReason,
      idempotencyKey: event.idempotencyKey,
      message,
    })
    stageBatchIdempotencyEntry({
      entries: state.idempotencyEntries,
      entry: denied.entry,
      stagedResultsByKey: state.stagedResultsByKey,
    })
    state.results.push(denied.result)
    return denied.result
  }

  private commitOptimizedBatch(params: {
    createdAt: number
    idempotencyEntries: BatchIdempotencyEntry[]
    meter: MeterIdentity
    meterState: MeterStateDraft
    touchedGrantStates: Map<string, GrantConsumptionState>
    wallet: WalletReservationSnapshot
    walletDirty: boolean
  }): OptimizedBatchWriteMetrics {
    const writeMetrics: OptimizedBatchWriteMetrics = {
      meter_state_write_count: params.meterState.dirty ? (params.meterState.exists ? 1 : 2) : 0,
      grant_window_write_count: unique(
        [...params.touchedGrantStates.values()].map((state) => state.periodKey)
      ).length,
      wallet_reservation_write_count: params.walletDirty && params.wallet ? 1 : 0,
      outbox_insert_count: 0,
      outbox_fact_count: 0,
      idempotency_insert_count: params.idempotencyEntries.length > 0 ? 1 : 0,
      idempotency_event_count: params.idempotencyEntries.length,
    }

    if (
      !params.meterState.dirty &&
      params.touchedGrantStates.size === 0 &&
      params.idempotencyEntries.length === 0 &&
      !params.walletDirty
    ) {
      return writeMetrics
    }

    // Keep replay seals, priced fact publish intent, and local accounting in one
    // synchronous DO SQLite transaction. No await belongs inside this block.
    this.db.transaction((tx) => {
      if (params.meterState.dirty) {
        this.ensureMeterState(tx, {
          meterKey: params.meter.key,
          createdAt: params.meterState.createdAt,
        })
        tx.update(meterStateTable)
          .set({
            usage: params.meterState.usage,
            updatedAt: params.meterState.updatedAt,
          })
          .where(eq(meterStateTable.meterKey, params.meter.key))
          .run()
      }

      this.writeGrantConsumptions(tx, params.touchedGrantStates.values())

      if (params.idempotencyEntries.length > 0) {
        tx.insert(idempotencyKeyBatchesTable)
          .values({
            createdAt: params.createdAt,
            entries: JSON.stringify(params.idempotencyEntries),
          })
          .run()
      }

      if (params.walletDirty && params.wallet) {
        tx.update(walletReservationTable)
          .set({
            consumedAmount: params.wallet.consumedAmount,
            consumedQuantity: params.wallet.consumedQuantity,
            targetReservationAmount: params.wallet.targetReservationAmount,
            spendEwmaAmount: params.wallet.spendEwmaAmount,
            lastRateSampledAtMs: params.wallet.lastRateSampledAtMs,
            maxEventCostAmount: params.wallet.maxEventCostAmount,
            refillInFlight: params.wallet.refillInFlight,
            pendingFlushSeq: params.wallet.pendingFlushSeq,
            pendingFlushFinal: params.wallet.pendingFlushFinal,
            pendingFlushAmount: params.wallet.pendingFlushAmount,
            pendingFlushQuantity: params.wallet.pendingFlushQuantity,
            pendingRefillAmount: params.wallet.pendingRefillAmount,
            lastEventAt: params.wallet.lastEventAt,
          })
          .run()
      }
    })

    this.recordBatchIdempotencyResults(params.idempotencyEntries)
    this.invalidateEnforcementStateCache()
    this.schedulePostCommitAlarm()

    return writeMetrics
  }

  private async applyInner(
    rawInput: ApplyInput,
    options: ApplyInnerOptions = {}
  ): Promise<ApplyResult> {
    const startTime = Date.now()
    const input = applyInputSchema.parse(rawInput)
    const idempotencyKey = input.idempotencyKey
    const createdAt = Date.now()
    const { activeGrants, creditLinePolicy, entitlement, meter, overageStrategy } =
      this.prepareSingleApplyContext(input, createdAt)

    // One canonical log line per apply() — populated as we go, emitted in
    // the finally block so every code path (success, denial, throw) lands
    // in the same wide event.
    const wideEvent = this.createSingleApplyWideEvent({
      activeGrants,
      creditLinePolicy,
      entitlement,
      idempotencyKey,
      input,
      meter,
    })

    let result: ApplyResult | undefined
    let thrown: unknown
    const metrics = createSingleApplyExecutionMetrics()

    try {
      const cachedResult = this.resolveCachedSingleApplyReplay({
        idempotencyKey,
        metrics,
        wideEvent,
      })
      if (cachedResult) {
        result = cachedResult
        return cachedResult
      }

      const lateDenial = this.rejectLateClosedPeriodSingleApply({
        activeGrants,
        createdAt,
        idempotencyKey,
        input,
        metrics,
        wideEvent,
      })
      if (lateDenial) {
        result = lateDenial
        return lateDenial
      }

      const bootstrap = await this.handleSingleApplyReservationBootstrap({
        activeGrants,
        createdAt,
        creditLinePolicy,
        idempotencyKey,
        input,
        meter,
        metrics,
        wideEvent,
      })
      if (bootstrap.result) {
        result = bootstrap.result
        return bootstrap.result
      }

      const execution = await this.executeSingleApplyWithWalletRecovery({
        activeGrants,
        createdAt,
        entitlement,
        idempotencyKey,
        input,
        meter,
        overageStrategy,
        usesWalletReservation: bootstrap.usesWalletReservation,
        wideEvent,
      })
      Object.assign(metrics, execution.metrics)
      result = execution.result
      return execution.result
    } catch (error) {
      thrown = error
      throw error
    } finally {
      this.logSingleApplyResult({
        emitLog: options.emitLog ?? true,
        metrics,
        result,
        startTime,
        thrown,
        wideEvent,
      })
    }
  }

  private resolveCachedSingleApplyReplay(params: {
    idempotencyKey: string
    metrics: SingleApplyExecutionMetrics
    wideEvent: Record<string, unknown>
  }): ApplyResult | null {
    const { idempotencyKey, metrics, wideEvent } = params
    // Idempotency short-circuit before any wallet I/O. A retried event with a
    // cached result must not re-call wallet.createReservation.
    const cachedResult = this.lookupCachedIdempotencyResult(idempotencyKey)
    if (!cachedResult) {
      wideEvent.idempotent_replay = false
      return null
    }

    metrics.duplicateCount = 1
    wideEvent.idempotent_replay = true
    return cachedResult
  }

  private rejectLateClosedPeriodSingleApply(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    idempotencyKey: string
    input: ApplyInput
    metrics: SingleApplyExecutionMetrics
    wideEvent: Record<string, unknown>
  }): ApplyResult | null {
    const { activeGrants, createdAt, idempotencyKey, input, metrics, wideEvent } = params
    const lateClosedPeriod = this.resolveLateClosedPeriod({
      activeGrants,
      eventTimestamp: input.event.timestamp,
      now: input.now,
    })

    if (!lateClosedPeriod) {
      wideEvent.late_event_rejected = false
      return null
    }

    const deniedResult = this.persistDeniedApplyResult({
      idempotencyKey,
      createdAt,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      message: `Event timestamp is ${lateClosedPeriod.lagMs}ms after the closed period grace window`,
    })
    metrics.idempotencyInsertCount = 1

    wideEvent.late_event_rejected = true
    wideEvent.late_event_lag_ms = lateClosedPeriod.lagMs
    wideEvent.late_event_period_end_at = lateClosedPeriod.periodEndAt
    return deniedResult
  }

  private async handleSingleApplyReservationBootstrap(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    creditLinePolicy: EntitlementCreditLinePolicy
    idempotencyKey: string
    input: ApplyInput
    meter: MeterIdentity
    metrics: SingleApplyExecutionMetrics
    wideEvent: Record<string, unknown>
  }): Promise<SingleApplyBootstrapOutcome> {
    const {
      activeGrants,
      createdAt,
      creditLinePolicy,
      idempotencyKey,
      input,
      meter,
      metrics,
      wideEvent,
    } = params
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
    const needsBootstrap = usesWalletReservation && (!preWindow || preWindow.reservationId === null)
    wideEvent.bootstrap_attempted = needsBootstrap

    if (!needsBootstrap) {
      wideEvent.bootstrap_outcome = usesWalletReservation
        ? "reservation_already_open"
        : "disabled_by_credit_line_policy"
      return { result: null, usesWalletReservation }
    }

    let denial: ApplyResult | null
    try {
      denial = await this.bootstrapReservationSingleFlight(input, activeGrants, meter)
    } catch (error) {
      wideEvent.bootstrap_outcome = "error"
      throw error
    }

    if (!denial) {
      wideEvent.bootstrap_outcome = "success"
      return { result: null, usesWalletReservation }
    }

    wideEvent.bootstrap_outcome = "denied"
    // Persist the denial idempotently so retries return the same answer
    // without re-calling the wallet. The DO's normal denial-cache pattern.
    const deniedResult = this.persistDeniedApplyResult({
      idempotencyKey,
      createdAt,
      deniedReason: denial.deniedReason,
      message: denial.message,
    })
    metrics.idempotencyInsertCount = 1
    return { result: deniedResult, usesWalletReservation }
  }

  private prepareSingleApplyContext(input: ApplyInput, createdAt: number): SingleApplyContext {
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

    return {
      activeGrants,
      creditLinePolicy: input.entitlement.creditLinePolicy,
      entitlement,
      meter: resolveMeterIdentity(entitlement),
      overageStrategy: entitlement.overageStrategy,
    }
  }

  private createSingleApplyWideEvent(params: {
    activeGrants: ActiveGrantInput[]
    creditLinePolicy: EntitlementCreditLinePolicy
    entitlement: EntitlementConfigInput
    idempotencyKey: string
    input: ApplyInput
    meter: MeterIdentity
  }): Record<string, unknown> {
    const { activeGrants, creditLinePolicy, entitlement, idempotencyKey, input, meter } = params
    return {
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
      currency: meter.currency,
      aggregation_method: meter.config.aggregationMethod,
      enforce_limit: input.enforceLimit,
      credit_line_policy: creditLinePolicy,
    }
  }

  private logSingleApplyResult(params: {
    emitLog: boolean
    metrics: SingleApplyExecutionMetrics
    result: ApplyResult | undefined
    startTime: number
    thrown: unknown
    wideEvent: Record<string, unknown>
  }): void {
    const { emitLog, metrics, result, startTime, thrown, wideEvent } = params
    wideEvent.event_count = 1
    wideEvent.processed_count = result ? 1 : 0
    wideEvent.duplicate_count = metrics.duplicateCount
    wideEvent.fact_count = metrics.insertedFactCount
    wideEvent.priced_fact_count = metrics.pricedFactCount
    wideEvent.grant_allocation_count = metrics.grantAllocationCount
    wideEvent.meter_state_write_count = metrics.meterStateWriteCount
    wideEvent.grant_window_write_count = metrics.grantWindowWriteCount
    wideEvent.wallet_reservation_write_count = metrics.walletReservationWriteCount
    wideEvent.outbox_insert_count = metrics.outboxInsertCount
    wideEvent.outbox_fact_count = metrics.outboxFactCount
    wideEvent.idempotency_insert_count = metrics.idempotencyInsertCount
    wideEvent.cost_minor = metrics.totalCost
    wideEvent.reservation_engaged = metrics.reservationEngaged

    const trigger = metrics.refillTrigger
    wideEvent.refill_triggered = trigger !== null
    if (trigger) {
      wideEvent.refill_seq = trigger.flushSeq
      wideEvent.reservation_refill_requested_amount = trigger.refillAmount
      wideEvent.refill_flush_amount = trigger.flushAmount
    }
    wideEvent.duration_ms = Date.now() - startTime

    addLedgerAmountDisplayFields(wideEvent, readLogCurrency(wideEvent), [
      "cost_minor",
      "reservation_refill_requested_amount",
      "refill_flush_amount",
      "sync_refill_cost_minor",
      "sync_refill_remaining_minor",
      "sync_refill_flush_amount",
      "sync_refill_requested_amount",
      "wallet_raw_cost_minor",
      "wallet_effective_cost_minor",
      "wallet_clamped_negative_minor",
      "reservation_remaining_amount",
      "reservation_target_amount",
      "reservation_threshold_amount",
    ])

    if (result) {
      this.clearSingleApplyErrorFields(wideEvent)
      wideEvent.allowed = result.allowed
      wideEvent.denied_reason = result.deniedReason ?? null
      if (!result.allowed) {
        wideEvent.deny_message = result.message ?? null
      } else {
        delete wideEvent.deny_message
      }
      wideEvent.outcome = result.allowed ? "success" : "denied"
    } else if (thrown) {
      this.clearSingleApplyDenialFields(wideEvent)
      wideEvent.outcome = "error"
      wideEvent.error_type = thrown instanceof Error ? thrown.name : "unknown"
      wideEvent.error_message = thrown instanceof Error ? thrown.message : String(thrown)
    }

    if (emitLog) {
      this.logger.info("entitlement apply", wideEvent)
    }
  }

  private clearSingleApplyErrorFields(wideEvent: Record<string, unknown>): void {
    delete wideEvent.error
    delete wideEvent.error_type
    delete wideEvent.error_message
    delete wideEvent["error.type"]
    delete wideEvent["error.message"]
    delete wideEvent["error.name"]
    delete wideEvent["error.stack"]
  }

  private clearSingleApplyDenialFields(wideEvent: Record<string, unknown>): void {
    delete wideEvent.allowed
    delete wideEvent.denied_reason
    delete wideEvent.deny_message
  }

  private async executeSingleApplyWithWalletRecovery(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    entitlement: EntitlementConfigInput
    idempotencyKey: string
    input: ApplyInput
    meter: MeterIdentity
    overageStrategy: OverageStrategy
    usesWalletReservation: boolean
    wideEvent: Record<string, unknown>
  }): Promise<{ metrics: SingleApplyExecutionMetrics; result: ApplyResult }> {
    const {
      activeGrants,
      createdAt,
      entitlement,
      idempotencyKey,
      input,
      meter,
      overageStrategy,
      usesWalletReservation,
      wideEvent,
    } = params
    const metrics = createSingleApplyExecutionMetrics()
    let synchronousRefillAttempted = false

    for (;;) {
      metrics.refillTrigger = null

      try {
        const txResult = this.commitSingleApplyTransaction({
          activeGrants,
          createdAt,
          entitlement,
          idempotencyKey,
          input,
          meter,
          metrics,
          overageStrategy,
          usesWalletReservation,
          wideEvent,
        })

        if (txResult.idempotencyEntry) {
          this.recordBatchIdempotencyResults([txResult.idempotencyEntry])
          this.schedulePostCommitAlarm()
        }

        // Flush+refill must happen after commit so the new consumed/refill
        // state is visible to `requestFlushAndRefill`, and must outlive the
        // request via `ctx.waitUntil` so it continues after apply() returns.
        if (metrics.refillTrigger) {
          this.ctx.waitUntil(this.requestFlushAndRefill(metrics.refillTrigger))
        }

        return { metrics, result: txResult.result }
      } catch (error) {
        const recovery = await this.recoverSingleApplyCommitError({
          createdAt,
          error,
          idempotencyKey,
          metrics,
          synchronousRefillAttempted,
          wideEvent,
        })
        synchronousRefillAttempted = recovery.synchronousRefillAttempted

        if (recovery.kind === "retry") {
          continue
        }

        return { metrics, result: recovery.result }
      }
    }
  }

  private async recoverSingleApplyCommitError(params: {
    createdAt: number
    error: unknown
    idempotencyKey: string
    metrics: SingleApplyExecutionMetrics
    synchronousRefillAttempted: boolean
    wideEvent: Record<string, unknown>
  }): Promise<SingleApplyErrorRecovery> {
    const { createdAt, idempotencyKey, metrics, wideEvent } = params
    let { synchronousRefillAttempted } = params
    let handledError: unknown = params.error

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
          return { kind: "retry", synchronousRefillAttempted }
        }
      }

      handledError = new EntitlementWindowWalletEmptyError(handledError.params)
    }

    if (handledError instanceof EntitlementWindowLimitExceededError) {
      const deniedResult = this.persistDeniedApplyResult({
        idempotencyKey,
        createdAt,
        deniedReason: "LIMIT_EXCEEDED",
        message: handledError.message,
        closeReason: "limit_reached",
      })
      metrics.idempotencyInsertCount = 1

      return { kind: "done", result: deniedResult, synchronousRefillAttempted }
    }

    if (handledError instanceof EntitlementWindowWalletEmptyError) {
      const deniedResult = this.persistDeniedApplyResult({
        idempotencyKey,
        createdAt,
        deniedReason: "WALLET_EMPTY",
        message: handledError.message,
        closeReason: "wallet_empty",
      })
      metrics.idempotencyInsertCount = 1

      return { kind: "done", result: deniedResult, synchronousRefillAttempted }
    }

    if (
      handledError instanceof EventTimestampTooFarInFutureError ||
      handledError instanceof EventTimestampTooOldError
    ) {
      throw handledError
    }

    throw handledError
  }

  private commitSingleApplyTransaction(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    entitlement: EntitlementConfigInput
    idempotencyKey: string
    input: ApplyInput
    meter: MeterIdentity
    metrics: SingleApplyExecutionMetrics
    overageStrategy: OverageStrategy
    usesWalletReservation: boolean
    wideEvent: Record<string, unknown>
  }): { idempotencyEntry: BatchIdempotencyEntry | null; result: ApplyResult } {
    const {
      activeGrants,
      createdAt,
      entitlement,
      idempotencyKey,
      input,
      meter,
      metrics,
      overageStrategy,
      usesWalletReservation,
      wideEvent,
    } = params

    return this.db.transaction((tx) => {
      const existingBatchEntry = this.getBatchIdempotencyResults().get(idempotencyKey)
      if (existingBatchEntry) {
        metrics.duplicateCount = 1
        return {
          idempotencyEntry: null,
          result: idempotencyEntryToApplyResult(existingBatchEntry),
        }
      }

      const pricedFacts = this.applyAndPriceSingleApplyEvent(tx, {
        activeGrants,
        createdAt,
        entitlement,
        input,
        meter,
        metrics,
        overageStrategy,
      })

      const walletSpend = this.applySingleApplyWalletReservationSpend(tx, {
        createdAt,
        entitlement,
        input,
        meter,
        metrics,
        pricedFacts,
        usesWalletReservation,
        wideEvent,
      })

      const meterFacts = pricedFacts.map((pricedFact) =>
        this.buildMeterFactPayload({
          createdAt,
          input,
          meter,
          pricedFact,
        })
      )
      metrics.outboxInsertCount = 0
      metrics.outboxFactCount = 0

      const idempotencyEntry = this.persistAllowedSingleApplyResult(tx, {
        createdAt,
        idempotencyKey,
        meterFacts,
        metrics,
      })

      this.stampSingleApplyWalletActivity(tx, {
        createdAt,
        metrics,
        walletSpend,
      })

      return {
        idempotencyEntry,
        result: { allowed: true, meterFacts } as ApplyResult,
      }
    })
  }

  private applyAndPriceSingleApplyEvent(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      activeGrants: ActiveGrantInput[]
      createdAt: number
      entitlement: EntitlementConfigInput
      input: ApplyInput
      meter: MeterIdentity
      metrics: SingleApplyExecutionMetrics
      overageStrategy: OverageStrategy
    }
  ): PricedFact[] {
    const { activeGrants, createdAt, entitlement, input, meter, metrics, overageStrategy } = params
    const { facts, meterState } = this.applySingleMeterEventInTransaction({
      activeGrants,
      createdAt,
      entitlement,
      input,
      meter,
      metrics,
      overageStrategy,
      tx,
    })

    this.persistMeterStateDraft(tx, { meter, meterState, metrics })

    const priced = this.priceFactsFromCompactGrantState(tx, {
      activeGrants,
      entitlement,
      eventTimestamp: input.event.timestamp,
      facts,
    })
    metrics.pricedFactCount = priced.pricedFacts.length
    metrics.grantAllocationCount = priced.touchedStateCount
    metrics.grantWindowWriteCount = priced.periodWriteCount

    return priced.pricedFacts
  }

  private applySingleApplyWalletReservationSpend(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      createdAt: number
      entitlement: EntitlementConfigInput
      input: ApplyInput
      meter: MeterIdentity
      metrics: SingleApplyExecutionMetrics
      pricedFacts: PricedFact[]
      usesWalletReservation: boolean
      wideEvent: Record<string, unknown>
    }
  ): SingleApplyWalletSpendOutcome {
    const {
      createdAt,
      entitlement,
      input,
      meter,
      metrics,
      pricedFacts,
      usesWalletReservation,
      wideEvent,
    } = params
    // Wallet check. Only engages when a reservation has been opened on
    // this window. Without a reservation the DO operates without local
    // allocation tracking or refill triggers.
    const window = this.refreshWalletReservationInvoiceContextIfMissing(
      tx,
      input,
      this.readWalletReservation(tx)
    )
    if (!usesWalletReservation || !window?.reservationId || pricedFacts.length === 0) {
      return { lastEventAtStamped: false, window }
    }

    metrics.reservationEngaged = true
    const walletSpend = this.applyWalletReservationSpendForEvent({
      createdAt,
      entitlement,
      input,
      meter,
      pricedFacts,
      tx,
      wideEvent,
      window: { ...window, reservationId: window.reservationId },
    })
    metrics.totalCost = walletSpend.totalCost
    metrics.walletReservationWriteCount += walletSpend.walletReservationWriteCount
    metrics.refillTrigger = walletSpend.refillTrigger
    return { lastEventAtStamped: true, window }
  }

  private stampSingleApplyWalletActivity(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      createdAt: number
      metrics: SingleApplyExecutionMetrics
      walletSpend: SingleApplyWalletSpendOutcome
    }
  ): void {
    const { createdAt, metrics, walletSpend } = params
    // Stamp the inactivity watermark on every successful commit. alarm()
    // uses `now - lastEventAt > INACTIVITY_THRESHOLD_MS` to decide when to
    // close out a dormant reservation without waiting for period end.
    if (!walletSpend.window?.reservationId || walletSpend.lastEventAtStamped) {
      return
    }

    tx.update(walletReservationTable).set({ lastEventAt: createdAt }).run()
    metrics.walletReservationWriteCount++
  }

  private applySingleMeterEventInTransaction(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    entitlement: EntitlementConfigInput
    input: ApplyInput
    meter: MeterIdentity
    metrics: SingleApplyExecutionMetrics
    overageStrategy: OverageStrategy
    tx: DrizzleSqliteDODatabase<typeof schema>
  }): { facts: Fact[]; meterState: MeterStateDraft } {
    const { activeGrants, createdAt, entitlement, input, meter, metrics, overageStrategy, tx } =
      params
    const meterState = this.readMeterStateDraft(tx, meter.key, createdAt)
    const adapter = new InMemoryMeterStorageAdapter(meterState)
    // The engine persists only raw aggregation state through its adapter.
    // Entitlement usage is written below into compact period state.
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
          states: this.readGrantStatesForActiveGrants(tx, activeGrants, input.event.timestamp),
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
    metrics.insertedFactCount = facts.length

    return { facts, meterState }
  }

  private persistMeterStateDraft(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      meter: MeterIdentity
      meterState: MeterStateDraft
      metrics: Pick<SingleApplyExecutionMetrics, "meterStateWriteCount">
    }
  ): void {
    const { meter, meterState, metrics } = params

    if (!meterState.dirty) {
      return
    }

    metrics.meterStateWriteCount = meterState.exists ? 1 : 2
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

  private persistAllowedSingleApplyResult(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      createdAt: number
      idempotencyKey: string
      meterFacts: BatchIdempotencyEntry["meterFacts"]
      metrics: Pick<SingleApplyExecutionMetrics, "idempotencyInsertCount">
    }
  ): BatchIdempotencyEntry {
    const { createdAt, idempotencyKey, meterFacts, metrics } = params
    const idempotencyEntry: BatchIdempotencyEntry = {
      eventId: idempotencyKey,
      createdAt,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
      meterFacts,
    }
    this.writeBatchIdempotencyResults(tx, [idempotencyEntry])
    metrics.idempotencyInsertCount = 1
    return idempotencyEntry
  }

  private applyWalletReservationSpendForEvent(params: {
    createdAt: number
    entitlement: EntitlementConfigInput
    input: ApplyInput
    meter: MeterIdentity
    pricedFacts: PricedFact[]
    tx: DrizzleSqliteDODatabase<typeof schema>
    wideEvent: Record<string, unknown>
    window: OpenWalletReservationSnapshot
  }): {
    refillTrigger: RefillTrigger | null
    totalCost: number
    walletReservationWriteCount: number
  } {
    const { createdAt, entitlement, input, meter, pricedFacts, tx, wideEvent, window } = params
    let walletReservationWriteCount = 0
    let refillTrigger: RefillTrigger | null = null

    // Pricing has already run through Dinero and was normalized into
    // ledger-scale integers. Mixed currencies are rejected at grant sync.
    const totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)
    const totalUnits = this.sumPositivePricedFactUnits(pricedFacts)
    const spendPlan = planWalletReservationSpend({
      createdAt,
      entitlement,
      eventTimestamp: input.event.timestamp,
      policy: this.reservationPolicy(),
      totalCost,
      totalUnits,
      window,
    })

    if (spendPlan.kind === "underfunded") {
      throw new EntitlementWindowReservationUnderfundedError({
        eventId: input.event.id,
        meterKey: meter.key,
        meterSlug: meter.config.eventSlug,
        reservationId: window.reservationId,
        cost: totalCost,
        remaining: spendPlan.currentRemaining,
        eventTimestamp: input.event.timestamp,
      })
    }

    wideEvent.wallet_raw_cost_minor = totalCost
    wideEvent.wallet_effective_cost_minor = spendPlan.effectiveCostAmount
    wideEvent.wallet_clamped_negative_minor = spendPlan.clampedNegativeAmount
    wideEvent.reservation_remaining_amount = spendPlan.remainingAmount
    wideEvent.reservation_target_amount = spendPlan.targetReservationAmount
    wideEvent.reservation_threshold_amount = spendPlan.thresholdAmount
    wideEvent.reservation_refill_requested_amount = spendPlan.refillAmount

    if (spendPlan.refillStateUpdate) {
      this.requireReservationInvoiceContext(window)
    }

    // Synchronous SQLite write before any post-commit action. On replay the
    // idempotency row short-circuits above, so this only runs on the
    // first-success path.
    tx.update(walletReservationTable).set(spendPlan.walletStateUpdate).run()
    walletReservationWriteCount++

    if (spendPlan.refillStateUpdate) {
      // pendingRefillAmount is part of the idempotency envelope for
      // flush:{reservationId}:{flushSeq}. Crash recovery may fold in newer
      // unflushed consumption, but the refill leg for an existing seq must stay
      // stable.
      tx.update(walletReservationTable).set(spendPlan.refillStateUpdate).run()
      walletReservationWriteCount++
      refillTrigger = spendPlan.refillTrigger
    }

    return { refillTrigger, totalCost, walletReservationWriteCount }
  }

  private sumPositivePricedFactUnits(pricedFacts: PricedFact[]): number {
    return pricedFacts.reduce((sum, fact) => sum + Math.max(0, fact.units), 0)
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

    const currency = extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig)

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
      outboxCount: 0,
      nextAlarmAt: this.nextAlarmAt ?? (await this.ctx.storage.getAlarm()),
      lastIdempotencyCleanupAt: this.lastIdempotencyCleanupAt,
      walletReservation: window
        ? {
            reservationId: window.reservationId,
            projectId: window.projectId,
            customerId: window.customerId,
            currency: window.currency,
            reservationEndAt: window.reservationEndAt,
            billingPeriodId: window.billingPeriodId,
            cycleEndAt: window.cycleEndAt,
            cycleStartAt: window.cycleStartAt,
            featurePlanVersionItemId: window.featurePlanVersionItemId,
            featureSlug: window.featureSlug,
            statementKey: window.statementKey,
            consumedAmount: window.consumedAmount,
            flushedAmount: window.flushedAmount,
            unflushedAmount: Math.max(0, window.consumedAmount - window.flushedAmount),
            consumedQuantity: window.consumedQuantity,
            flushedQuantity: window.flushedQuantity,
            unflushedQuantity: Math.max(0, window.consumedQuantity - window.flushedQuantity),
            allocationAmount: window.allocationAmount,
            refillInFlight: window.refillInFlight,
            flushSeq: window.flushSeq,
            pendingFlushSeq: window.pendingFlushSeq,
            pendingFlushFinal: window.pendingFlushFinal,
            pendingFlushAmount: window.pendingFlushAmount,
            pendingFlushQuantity: window.pendingFlushQuantity,
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
      const remainingOutboxCount = 0
      const tinybirdFlushFailed = false
      wideEvent.tinybird_flush_failed = tinybirdFlushFailed

      wideEvent.idempotency_cleaned = this.runAlarmIdempotencyCleanup(now, wideEvent)

      wideEvent.outbox_remaining = remainingOutboxCount
      wideEvent.outbox_alert = false

      const inactivityMs = inactivityThresholdMs(this.runtimeEnv)
      const closeHandled = await this.handleAlarmReservationClose({
        inactivityMs,
        now,
        tinybirdFlushFailed,
        wideEvent,
      })
      if (closeHandled) {
        return
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
      wideEvent.time_flush_triggered = await this.triggerTimeBasedWalletFlush({
        flushIntervalMs,
        now,
        wideEvent,
      })

      await this.handleAlarmLifecycle({
        flushIntervalMs,
        inactivityMs,
        now,
        remainingOutboxCount,
        tinybirdFlushFailed,
        wideEvent,
      })
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

  private async handleAlarmLifecycle(params: {
    flushIntervalMs: number
    inactivityMs: number
    now: number
    remainingOutboxCount: number
    tinybirdFlushFailed: boolean
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const {
      flushIntervalMs,
      inactivityMs,
      now,
      remainingOutboxCount,
      tinybirdFlushFailed,
      wideEvent,
    } = params
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

      // We don't know when this DO can be safely collected. Go to sleep.
      // Next apply() will wake us up.
      wideEvent.outcome = "idle"
      return
    }

    // After the latest known grant/reservation window we keep the DO alive
    // for the full idempotency TTL before self-destructing.
    const selfDestructAt = lifecycleEndAt + DO_IDEMPOTENCY_TTL_MS

    if (now > selfDestructAt) {
      await this.handleRetentionCleanupAlarm({
        lifecycleEndAt,
        now,
        remainingOutboxCount,
        selfDestructAt,
        tinybirdFlushFailed,
        wideEvent,
      })
      return
    }

    await this.scheduleNextLifecycleAlarm({
      flushIntervalMs,
      inactivityMs,
      now,
      remainingOutboxCount,
      selfDestructAt,
      wideEvent,
    })
  }

  private async handleAlarmReservationClose(params: {
    inactivityMs: number
    now: number
    tinybirdFlushFailed: boolean
    wideEvent: Record<string, unknown>
  }): Promise<boolean> {
    const { inactivityMs, now, tinybirdFlushFailed, wideEvent } = params

    // Final-flush detection. Any of three triggers converges on the same
    // flush path: period end, inactivity, or an explicit deletion
    // request. A DO without a reservation (or one marked
    // `recoveryRequired`) skips the flush — there's nothing to close out
    // or the last attempt failed terminally and an operator has to look.
    const window = this.readWalletReservation(this.db)

    wideEvent.reservation_id = window?.reservationId ?? null
    wideEvent.recovery_required = window?.recoveryRequired ?? false

    if (!window?.reservationId || window.recoveryRequired) {
      return false
    }
    const closeWindow: OpenWalletReservationSnapshot = {
      ...window,
      reservationId: window.reservationId,
    }

    const trigger = this.resolveAlarmReservationCloseTrigger({
      inactivityMs,
      now,
      window: closeWindow,
    })
    if (!trigger) {
      return false
    }

    wideEvent.close_reservation_reason = trigger.closeReason
    const hasPendingWalletFlush = this.hasPendingWalletFlush(window)
    const isPendingFinalFlush = hasPendingWalletFlush && window.pendingFlushFinal

    if (hasPendingWalletFlush && !isPendingFinalFlush) {
      return await this.deferAlarmReservationCloseForPendingFlush({
        isDeletionPending: trigger.isDeletionPending,
        wideEvent,
        window: closeWindow,
      })
    }

    const closeFailed = await this.closeTriggeredAlarmReservation({
      closeReason: trigger.closeReason,
      isDeletionPending: trigger.isDeletionPending,
      isPendingFinalFlush,
      wideEvent,
      window: closeWindow,
    })
    if (closeFailed) {
      return true
    }

    if (trigger.isDeletionPending) {
      await this.handleDeletionCleanupAlarm({
        now,
        originalWindow: closeWindow,
        tinybirdFlushFailed,
        wideEvent,
      })
      return true
    }

    return false
  }

  private resolveAlarmReservationCloseTrigger(params: {
    inactivityMs: number
    now: number
    window: OpenWalletReservationSnapshot
  }): AlarmReservationCloseTrigger | null {
    const { inactivityMs, now, window } = params
    const isPeriodEnd = window.reservationEndAt !== null && now >= window.reservationEndAt
    const isInactive = window.lastEventAt !== null && now - window.lastEventAt >= inactivityMs
    const isDeletionPending = window.deletionRequested

    if (!isPeriodEnd && !isInactive && !isDeletionPending) {
      return null
    }

    return {
      closeReason: isDeletionPending
        ? "deletion_requested"
        : isPeriodEnd
          ? "period_close"
          : "inactivity",
      isDeletionPending,
    }
  }

  private async deferAlarmReservationCloseForPendingFlush(params: {
    isDeletionPending: boolean
    wideEvent: Record<string, unknown>
    window: OpenWalletReservationSnapshot
  }): Promise<boolean> {
    const { isDeletionPending, wideEvent, window } = params
    wideEvent.close_reservation_deferred = true
    wideEvent.pending_flush_seq = window.pendingFlushSeq
    wideEvent.refill_in_flight = window.refillInFlight

    if (!isDeletionPending) {
      return false
    }

    this.logOperatorActionRequired("entitlement deletion has pending wallet flush", {
      pending_flush_seq: window.pendingFlushSeq,
      refill_in_flight: window.refillInFlight,
      reservation_id: window.reservationId,
    })
    wideEvent.operator_action_required = true
    wideEvent.outcome = "operator_required"
    await this.ctx.storage.deleteAlarm()
    return true
  }

  private async closeTriggeredAlarmReservation(params: {
    closeReason: ReservationCloseReason
    isDeletionPending: boolean
    isPendingFinalFlush: boolean
    wideEvent: Record<string, unknown>
    window: OpenWalletReservationSnapshot
  }): Promise<boolean> {
    const { closeReason, isDeletionPending, isPendingFinalFlush, wideEvent, window } = params
    const closeResult = await this.closeReservation({
      allowDeletionRequested: isDeletionPending,
      closeReason,
      recoverPendingFinal: isPendingFinalFlush,
    })
    wideEvent.close_reservation_ok = closeResult.ok
    wideEvent.close_reservation_outcome = closeResult.outcome

    if (closeResult.ok) {
      return false
    }

    wideEvent.close_reservation_error_message = closeResult.errorMessage ?? null
    wideEvent.operator_action_required = true
    wideEvent.outcome = "operator_required"
    this.logOperatorActionRequired("entitlement wallet reservation close failed", {
      error_message: closeResult.errorMessage ?? null,
      close_reservation_outcome: closeResult.outcome,
      reservation_id: window.reservationId,
    })
    await this.ctx.storage.deleteAlarm()
    return true
  }

  private runAlarmIdempotencyCleanup(now: number, wideEvent: Record<string, unknown>): number {
    // Keep idempotency keys beyond the public ingestion cap so delayed cleanup
    // cannot erase the replay seal for an event we would accept.
    const runIdempotencyCleanup = this.shouldRunIdempotencyCleanup(now)
    wideEvent.idempotency_cleanup_ran = runIdempotencyCleanup

    if (!runIdempotencyCleanup) {
      return 0
    }

    const staleIdempotencyCount = this.cleanupStaleIdempotencyKeys(now)
    this.lastIdempotencyCleanupAt = now
    wideEvent.idempotency_next_cleanup_at = now + IDEMPOTENCY_CLEANUP_INTERVAL_MS
    return staleIdempotencyCount
  }

  private async triggerTimeBasedWalletFlush(params: {
    flushIntervalMs: number
    now: number
    wideEvent: Record<string, unknown>
  }): Promise<boolean> {
    const { flushIntervalMs, now, wideEvent } = params
    const postFlushWindow = this.readWalletReservation(this.db)
    if (
      !postFlushWindow?.reservationId ||
      postFlushWindow.recoveryRequired ||
      postFlushWindow.refillInFlight
    ) {
      return false
    }

    const unflushed = Math.max(0, postFlushWindow.consumedAmount - postFlushWindow.flushedAmount)
    const unflushedQuantity = Math.max(
      0,
      postFlushWindow.consumedQuantity - postFlushWindow.flushedQuantity
    )
    const elapsedSinceLastFlush =
      postFlushWindow.lastFlushedAt !== null
        ? now - postFlushWindow.lastFlushedAt
        : Number.POSITIVE_INFINITY

    if (unflushed <= 0 || elapsedSinceLastFlush < flushIntervalMs) {
      return false
    }

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
    wideEvent.time_flush_quantity = unflushedQuantity
    this.db
      .update(walletReservationTable)
      .set({
        refillInFlight: true,
        pendingFlushSeq: nextSeq,
        pendingFlushFinal: false,
        pendingFlushAmount: unflushed,
        pendingFlushQuantity: unflushedQuantity,
        pendingRefillAmount: 0,
        spendEwmaAmount: spendVelocity.spendEwmaAmount,
        lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
      })
      .run()
    await this.requestFlushAndRefill({
      flushSeq: nextSeq,
      flushAmount: unflushed,
      flushQuantity: unflushedQuantity,
      // Time-driven flush is purely about ledger freshness — don't top up
      // allocation here. The DO's own refill trigger handles that when the
      // threshold is actually crossed.
      refillAmount: 0,
      effectiveAt: Date.now(),
    })

    return true
  }

  private async handleDeletionCleanupAlarm(params: {
    now: number
    originalWindow: OpenWalletReservationSnapshot
    tinybirdFlushFailed: boolean
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { now, originalWindow, tinybirdFlushFailed, wideEvent } = params
    const latestWindow = this.readWalletReservation(this.db)
    const latestOutboxCount = 0
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
        reservation_id: latestWindow ? latestWindow.reservationId : originalWindow.reservationId,
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
  }

  private async handleRetentionCleanupAlarm(params: {
    lifecycleEndAt: number
    now: number
    remainingOutboxCount: number
    selfDestructAt: number
    tinybirdFlushFailed: boolean
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const {
      lifecycleEndAt,
      now,
      remainingOutboxCount,
      selfDestructAt,
      tinybirdFlushFailed,
      wideEvent,
    } = params
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
  }

  private async scheduleNextLifecycleAlarm(params: {
    flushIntervalMs: number
    inactivityMs: number
    now: number
    remainingOutboxCount: number
    selfDestructAt: number
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { flushIntervalMs, inactivityMs, now, remainingOutboxCount, selfDestructAt, wideEvent } =
      params
    // Pick the soonest among: pending wallet recheck, time-based flush
    // deadline, reservation close deadlines, and self-destruct. Re-read the
    // window because the time-flush may have just updated `lastFlushedAt`.
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

  // Public RPC: flush unflushed consumed usage for invoicing without closing
  // the reservation. The billing endpoint calls this before BILL materializes
  // an invoice, so the ledger reflects captured usage up to this moment.
  // The reservation stays open so new events continue being tracked.
  public async flushReservationForInvoicing(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    return runDoOperation(
      {
        requestId: this.ctx.id.toString(),
        service: "entitlementwindow",
        operation: "flush_reservation_for_invoicing",
        waitUntil: (p) => this.ctx.waitUntil(p),
      },
      async () => this.flushReservationForInvoicingInner(input)
    )
  }

  private async flushReservationForInvoicingInner(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    const startTime = Date.now()
    const window = this.readWalletReservation(this.db)
    const wideEvent: Record<string, unknown> = {
      operation: "flush_reservation_for_invoicing",
      statement_key: input.statementKey,
      billing_period_ids: input.billingPeriodIds,
      reservation_id: window?.reservationId ?? null,
      project_id: window?.projectId ?? null,
      customer_id: window?.customerId ?? null,
      currency: window?.currency ?? null,
      consumed_amount: window?.consumedAmount ?? null,
      flushed_amount: window?.flushedAmount ?? null,
    }

    try {
      if (!window?.reservationId) {
        wideEvent.outcome = "no_reservation"
        return { ok: true, outcome: "no_reservation" }
      }

      if (window.recoveryRequired) {
        wideEvent.outcome = "recovery_required"
        return { ok: false, outcome: "recovery_required" }
      }

      // Verify the reservation belongs to this statement or billing period group.
      const ownsStatement =
        window.statementKey === input.statementKey ||
        (window.billingPeriodId !== null && input.billingPeriodIds.includes(window.billingPeriodId))

      if (!ownsStatement) {
        wideEvent.outcome = "statement_mismatch"
        const errorMessage = `Reservation ${window.reservationId} belongs to statement ${window.statementKey ?? "unknown"}`
        wideEvent.error_message = errorMessage
        return { ok: false, outcome: "statement_mismatch", errorMessage }
      }

      if (this.hasPendingWalletFlush(window)) {
        wideEvent.outcome = "deferred"
        return {
          ok: false,
          outcome: "deferred",
          errorMessage: "Reservation already has a pending wallet flush",
        }
      }

      const flushAmount = Math.max(0, window.consumedAmount - window.flushedAmount)
      const flushQuantity = Math.max(0, window.consumedQuantity - window.flushedQuantity)
      if (flushAmount <= 0) {
        wideEvent.outcome = "no_unflushed_usage"
        return { ok: true, outcome: "no_unflushed_usage" }
      }

      const flushSeq = window.flushSeq + 1
      wideEvent.flush_seq = flushSeq
      wideEvent.flush_amount = flushAmount
      wideEvent.flush_quantity = flushQuantity

      this.db
        .update(walletReservationTable)
        .set({
          refillInFlight: true,
          pendingFlushSeq: flushSeq,
          pendingFlushFinal: false,
          pendingFlushAmount: flushAmount,
          pendingFlushQuantity: flushQuantity,
          pendingRefillAmount: 0,
        })
        .run()

      await this.requestFlushAndRefill({
        flushSeq,
        flushAmount,
        flushQuantity,
        refillAmount: 0,
        effectiveAt: Date.now(),
      })

      const after = this.readWalletReservation(this.db)
      if (after?.pendingFlushSeq !== null || after?.flushSeq !== flushSeq) {
        wideEvent.outcome = "wallet_error"
        return {
          ok: false,
          outcome: "wallet_error",
          errorMessage: "Reservation flush did not complete",
        }
      }

      wideEvent.outcome = "flushed"
      return { ok: true, outcome: "flushed" }
    } catch (error) {
      this.logger.error(error, {
        context: "flush_reservation_for_invoicing threw unexpectedly",
        flushSeq: window ? window.flushSeq + 1 : null,
        reservationId: window?.reservationId ?? null,
      })
      wideEvent.outcome = "wallet_error"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        outcome: "wallet_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    } finally {
      wideEvent.duration_ms = Date.now() - startTime
      addLedgerAmountDisplayFields(wideEvent, readLogCurrency(wideEvent), [
        "consumed_amount",
        "flushed_amount",
        "flush_amount",
      ])
      this.logger.info("entitlement flush_reservation_for_invoicing", wideEvent)
    }
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
      const precondition = this.resolveReservationClosePreconditions({
        options,
        wideEvent,
        window,
      })
      if (precondition.kind === "done") {
        return precondition.result
      }
      const { isRecoveringPendingFinal } = precondition
      const closeWindow = precondition.window

      return await this.closeReservationWithWallet({
        closeReason: options.closeReason,
        isRecoveringPendingFinal,
        wideEvent,
        window: closeWindow,
      })
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
      addLedgerAmountDisplayFields(wideEvent, readLogCurrency(wideEvent), [
        "flushed_amount",
        "flushed_after",
        "released_amount",
        "restored_granted_amount",
        "refunded_purchased_amount",
      ])
      this.logger.info("entitlement close_reservation", wideEvent)
    }
  }

  private async closeReservationWithWallet(params: {
    closeReason: ReservationCloseReason
    isRecoveringPendingFinal: boolean
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<CloseReservationResult> {
    const { closeReason, isRecoveringPendingFinal, wideEvent, window } = params
    const walletService = this.getWalletService()
    const durableObjectId = this.ctx.id.toString()
    const invoiceContext = this.requireReservationInvoiceContext(window)
    const flushIntent = this.persistFinalReservationFlushIntent({
      isRecoveringPendingFinal,
      wideEvent,
      window,
    })

    const capture = await this.captureFinalReservationUsage({
      durableObjectId,
      invoiceContext,
      isRecoveringPendingFinal,
      nextSeq: flushIntent.nextSeq,
      unflushed: flushIntent.unflushed,
      unflushedQuantity: flushIntent.unflushedQuantity,
      walletService,
      wideEvent,
      window,
    })
    if (capture.kind === "done") {
      return capture.result
    }

    const release = await this.releaseFinalReservation({
      closeReason,
      durableObjectId,
      isRecoveringPendingFinal,
      nextSeq: flushIntent.nextSeq,
      walletService,
      wideEvent,
      window,
    })
    if (release.kind === "done") {
      return release.result
    }

    return this.finalizeSuccessfulReservationClose({
      capture,
      nextSeq: flushIntent.nextSeq,
      release,
      wideEvent,
      window,
    })
  }

  private persistFinalReservationFlushIntent(params: {
    isRecoveringPendingFinal: boolean
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): ReservationCloseFlushIntent {
    const { isRecoveringPendingFinal, wideEvent, window } = params
    const derivedUnflushed = Math.max(0, window.consumedAmount - window.flushedAmount)
    const derivedUnflushedQuantity = Math.max(0, window.consumedQuantity - window.flushedQuantity)
    if (
      isRecoveringPendingFinal &&
      (window.pendingFlushAmount === null || window.pendingFlushQuantity === null)
    ) {
      throw new Error(
        `Wallet reservation ${window.reservationId} is missing pending final flush metadata`
      )
    }
    const unflushed = isRecoveringPendingFinal ? window.pendingFlushAmount! : derivedUnflushed
    const unflushedQuantity = isRecoveringPendingFinal
      ? window.pendingFlushQuantity!
      : derivedUnflushedQuantity
    const nextSeq = isRecoveringPendingFinal ? window.pendingFlushSeq! : window.flushSeq + 1
    wideEvent.flush_seq = nextSeq
    wideEvent.flush_amount = unflushed
    wideEvent.flush_quantity = unflushedQuantity
    wideEvent.recovering_pending_final = isRecoveringPendingFinal

    this.db
      .update(walletReservationTable)
      .set({
        pendingFlushSeq: nextSeq,
        pendingFlushFinal: true,
        pendingFlushAmount: unflushed,
        pendingFlushQuantity: unflushedQuantity,
        pendingRefillAmount: 0,
        refillInFlight: true,
      })
      .run()

    return { nextSeq, unflushed, unflushedQuantity }
  }

  private async captureFinalReservationUsage(params: {
    durableObjectId: string
    invoiceContext: ReservationInvoiceContext
    isRecoveringPendingFinal: boolean
    nextSeq: number
    unflushed: number
    unflushedQuantity: number
    walletService: WalletService
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<ReservationCloseCaptureOutcome> {
    const {
      durableObjectId,
      invoiceContext,
      isRecoveringPendingFinal,
      nextSeq,
      unflushed,
      unflushedQuantity,
      walletService,
      wideEvent,
      window,
    } = params
    const captureResult = await walletService.captureReservationUsage({
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      flushSeq: nextSeq,
      amount: unflushed,
      billingPeriodId: invoiceContext.billingPeriodId,
      kind: "usage",
      statementKey: invoiceContext.statementKey,
      metadata: {
        billing_period_id: invoiceContext.billingPeriodId,
        cycle_end_at: invoiceContext.cycleEndAt,
        cycle_start_at: invoiceContext.cycleStartAt,
        feature_plan_version_item_id: invoiceContext.featurePlanVersionItemId,
        feature_slug: invoiceContext.featureSlug,
        quantity: unflushedQuantity,
        source_id: invoiceContext.sourceId,
        requestedBy: "durable_object",
        requestedById: durableObjectId,
        durableObjectId,
        durable_object_id: durableObjectId,
        reservation_id: window.reservationId,
        flush_seq: nextSeq,
      },
      sourceId: invoiceContext.sourceId,
    })

    if (!captureResult.err) {
      return {
        kind: "captured",
        capturedAmount: captureResult.val.capturedAmount,
        capturedQuantity: unflushedQuantity,
      }
    }

    if (
      isRecoveringPendingFinal &&
      captureResult.err.message === "WALLET_RESERVATION_ALREADY_RECONCILED"
    ) {
      return {
        kind: "done",
        result: this.markReservationAlreadyReconciled({ nextSeq, wideEvent, window }),
      }
    }

    return {
      kind: "done",
      result: this.markReservationCloseWalletError({
        context: "reservation close capture failed",
        error: captureResult.err,
        nextSeq,
        wideEvent,
        window,
      }),
    }
  }

  private async releaseFinalReservation(params: {
    closeReason: ReservationCloseReason
    durableObjectId: string
    isRecoveringPendingFinal: boolean
    nextSeq: number
    walletService: WalletService
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<ReservationCloseReleaseOutcome> {
    const {
      closeReason,
      durableObjectId,
      isRecoveringPendingFinal,
      nextSeq,
      walletService,
      wideEvent,
      window,
    } = params
    const releaseResult = await walletService.releaseReservation({
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      closeReason,
      idempotencyKey: `release:${window.reservationId}:${closeReason}`,
      metadata: {
        requestedBy: "durable_object",
        requestedById: durableObjectId,
        durableObjectId,
      },
      sourceId: durableObjectId,
    })

    if (!releaseResult.err) {
      return {
        kind: "released",
        refundedPurchasedAmount: releaseResult.val.refundedPurchasedAmount,
        releasedAmount: releaseResult.val.releasedAmount,
        restoredGrantedAmount: releaseResult.val.restoredGrantedAmount,
      }
    }

    if (
      isRecoveringPendingFinal &&
      releaseResult.err.message === "WALLET_RESERVATION_ALREADY_RECONCILED"
    ) {
      return {
        kind: "done",
        result: this.markReservationAlreadyReconciled({ nextSeq, wideEvent, window }),
      }
    }

    return {
      kind: "done",
      result: this.markReservationCloseWalletError({
        context: "reservation close release failed",
        error: releaseResult.err,
        nextSeq,
        wideEvent,
        window,
      }),
    }
  }

  private finalizeSuccessfulReservationClose(params: {
    capture: Extract<ReservationCloseCaptureOutcome, { kind: "captured" }>
    nextSeq: number
    release: Extract<ReservationCloseReleaseOutcome, { kind: "released" }>
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): CloseReservationResult {
    const { capture, nextSeq, release, wideEvent, window } = params
    // Reservation closed. Clear the id so future apply()s on this DO
    // skip the wallet check until activateEntitlement opens a new one,
    // and roll the flush bookkeeping forward. We don't zero
    // consumed/allocation: they're historical totals and a reconciler
    // reading SQLite shouldn't lose them.
    this.db
      .update(walletReservationTable)
      .set({
        reservationId: null,
        flushedAmount: window.flushedAmount + capture.capturedAmount,
        flushedQuantity: window.flushedQuantity + capture.capturedQuantity,
        flushSeq: nextSeq,
        pendingFlushSeq: null,
        pendingFlushFinal: false,
        pendingFlushAmount: null,
        pendingFlushQuantity: null,
        pendingRefillAmount: 0,
        refillInFlight: false,
        lastFlushedAt: Date.now(),
      })
      .run()

    wideEvent.flushed_amount = capture.capturedAmount
    wideEvent.flushed_quantity = capture.capturedQuantity
    wideEvent.flushed_after = window.flushedAmount + capture.capturedAmount
    wideEvent.released_amount = release.releasedAmount
    wideEvent.restored_granted_amount = release.restoredGrantedAmount
    wideEvent.refunded_purchased_amount = release.refundedPurchasedAmount
    wideEvent.outcome = "success"
    addLedgerAmountDisplayFields(wideEvent, window.currency, [
      "flushed_amount",
      "flushed_after",
      "released_amount",
      "restored_granted_amount",
      "refunded_purchased_amount",
    ])
    return { ok: true, outcome: "success" }
  }

  private resolveReservationClosePreconditions(params: {
    options: CloseReservationOptions
    wideEvent: Record<string, unknown>
    window: WalletReservationSnapshot
  }):
    | { kind: "done"; result: CloseReservationResult }
    | {
        kind: "ready"
        isRecoveringPendingFinal: boolean
        window: ClosableWalletReservationSnapshot
      } {
    const { options, wideEvent, window } = params

    if (!window?.reservationId) {
      wideEvent.outcome = "no_reservation"
      return { kind: "done", result: { ok: true, outcome: "no_reservation" } }
    }

    if (!window.projectId || !window.customerId) {
      this.logger.error("reservation close requested without reservation identifiers", {
        reservationId: window.reservationId,
        projectId: window.projectId,
        customerId: window.customerId,
      })
      wideEvent.outcome = "no_reservation"
      return { kind: "done", result: { ok: true, outcome: "no_reservation" } }
    }

    if (window.recoveryRequired) {
      wideEvent.outcome = "deferred"
      wideEvent.reason = "recovery_required"
      return {
        kind: "done",
        result: { ok: true, outcome: "deferred", reason: "recovery_required" },
      }
    }

    if (window.deletionRequested && !options.allowDeletionRequested) {
      wideEvent.outcome = "deferred"
      wideEvent.reason = "deletion_requested"
      return {
        kind: "done",
        result: { ok: true, outcome: "deferred", reason: "deletion_requested" },
      }
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
      return {
        kind: "done",
        result: { ok: true, outcome: "deferred", reason: "pending_wallet_flush" },
      }
    }

    return {
      kind: "ready",
      isRecoveringPendingFinal,
      window: {
        ...window,
        customerId: window.customerId,
        projectId: window.projectId,
        reservationId: window.reservationId,
      },
    }
  }

  private markReservationAlreadyReconciled(params: {
    nextSeq: number
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): CloseReservationResult {
    const { nextSeq, wideEvent, window } = params
    this.db
      .update(walletReservationTable)
      .set({
        reservationId: null,
        flushedAmount: Math.max(window.flushedAmount, window.consumedAmount),
        flushedQuantity: Math.max(window.flushedQuantity, window.consumedQuantity),
        flushSeq: nextSeq,
        pendingFlushSeq: null,
        pendingFlushFinal: false,
        pendingFlushAmount: null,
        pendingFlushQuantity: null,
        pendingRefillAmount: 0,
        refillInFlight: false,
        lastFlushedAt: Date.now(),
      })
      .run()

    wideEvent.flushed_amount = Math.max(0, window.consumedAmount - window.flushedAmount)
    wideEvent.flushed_quantity = Math.max(0, window.consumedQuantity - window.flushedQuantity)
    wideEvent.flushed_after = Math.max(window.flushedAmount, window.consumedAmount)
    wideEvent.outcome = "already_reconciled"
    addLedgerAmountDisplayFields(wideEvent, window.currency, ["flushed_amount", "flushed_after"])
    return { ok: true, outcome: "already_reconciled" }
  }

  private markReservationCloseWalletError(params: {
    context: string
    error: Error
    nextSeq: number
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): CloseReservationResult {
    const { context, error, nextSeq, wideEvent, window } = params
    this.logger.error(error, {
      context,
      flushSeq: nextSeq,
      reservationId: window.reservationId,
    })
    // Leave pendingFlushSeq set so an operator can inspect/replay the same seq;
    // the ledger idempotency key keeps replays safe. Mark recoveryRequired so
    // alarm() does not keep trying to close/delete.
    this.db
      .update(walletReservationTable)
      .set({ recoveryRequired: true, refillInFlight: false })
      .run()
    wideEvent.outcome = "wallet_error"
    wideEvent.error_message = error.message
    return {
      errorMessage: error.message,
      ok: false,
      outcome: "wallet_error",
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
      billingPeriodId?: string | null
      cycleEndAt?: number | null
      cycleStartAt?: number | null
      featurePlanVersionItemId?: string | null
      featureSlug?: string | null
      statementKey?: string | null
    }
  ): void {
    tx.insert(walletReservationTable)
      .values({
        id: WALLET_RESERVATION_ROW_ID,
        projectId: params.projectId,
        customerId: params.customerId,
        currency: params.currency,
        reservationEndAt: params.reservationEndAt,
        billingPeriodId: params.billingPeriodId ?? null,
        cycleEndAt: params.cycleEndAt ?? null,
        cycleStartAt: params.cycleStartAt ?? null,
        featurePlanVersionItemId: params.featurePlanVersionItemId ?? null,
        featureSlug: params.featureSlug ?? null,
        statementKey: params.statementKey ?? null,
      })
      .onConflictDoNothing({ target: walletReservationTable.id })
      .run()

    tx.update(walletReservationTable)
      .set({
        projectId: params.projectId,
        customerId: params.customerId,
        currency: params.currency,
        reservationEndAt: params.reservationEndAt,
        billingPeriodId: params.billingPeriodId ?? null,
        cycleEndAt: params.cycleEndAt ?? null,
        cycleStartAt: params.cycleStartAt ?? null,
        featurePlanVersionItemId: params.featurePlanVersionItemId ?? null,
        featureSlug: params.featureSlug ?? null,
        statementKey: params.statementKey ?? null,
      })
      .run()
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
      billingPeriods: [],
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
      subscriptionItemId: null,
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
        currencyCode: extractCurrencyCodeFromFeatureConfig(entitlement.featureConfig) ?? "USD",
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt ?? null,
        grantId: row.grantId,
        priority: row.priority,
        resetConfig: entitlement.resetConfig ?? null,
      }))
  }

  private readGrantStatesForActiveGrants(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[] {
    const buckets = grants
      .map((grant) => computeGrantPeriodBucket(grant, timestamp))
      .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
    const bucketKeys = new Set(buckets.map((bucket) => bucket.bucketKey))
    const periodKeys = unique(buckets.map((bucket) => bucket.periodKey))

    if (bucketKeys.size === 0 || periodKeys.length === 0) {
      return []
    }

    return this.readGrantStatesForPeriodKeys(tx, periodKeys).filter((state) =>
      bucketKeys.has(state.bucketKey)
    )
  }

  private readGrantStatesForBatch(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    grants: ActiveGrantInput[],
    timestamps: number[]
  ): GrantConsumptionState[] {
    const buckets = timestamps.flatMap((timestamp) =>
      grants
        .map((grant) => computeGrantPeriodBucket(grant, timestamp))
        .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
    )
    const bucketKeys = new Set(buckets.map((bucket) => bucket.bucketKey))
    const periodKeys = unique(buckets.map((bucket) => bucket.periodKey))

    if (bucketKeys.size === 0 || periodKeys.length === 0) {
      return []
    }

    return this.readGrantStatesForPeriodKeys(tx, periodKeys).filter((state) =>
      bucketKeys.has(state.bucketKey)
    )
  }

  private readGrantStatesForPeriodKeys(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    periodKeys: string[]
  ): GrantConsumptionState[] {
    const states: GrantConsumptionState[] = []

    for (let i = 0; i < periodKeys.length; i += APPLY_BATCH_SIZE_LIMIT) {
      const rows = tx
        .select({
          grantStatesJson: entitlementPeriodUsageTable.grantStatesJson,
        })
        .from(entitlementPeriodUsageTable)
        .where(
          inArray(
            entitlementPeriodUsageTable.periodKey,
            periodKeys.slice(i, i + APPLY_BATCH_SIZE_LIMIT)
          )
        )
        .all()

      for (const row of rows) {
        states.push(...this.parseCompactGrantStates(row.grantStatesJson))
      }
    }

    return states
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

  private buildMeterFactPayload(params: {
    createdAt: number
    input: ApplyInput
    meter: MeterIdentity
    pricedFact: PricedFact
  }): EntitlementApplyMeterFact {
    const { createdAt, input, meter, pricedFact } = params

    return {
      event_id: input.event.id,
      idempotency_key: input.idempotencyKey,
      workspace_id: input.event.source.workspaceId,
      project_id: input.projectId,
      customer_id: input.customerId,
      environment: input.event.source.environment,
      api_key_id: input.event.source.apiKeyId,
      source_type: input.event.source.sourceType,
      source_id: input.event.source.sourceId,
      source_name: input.event.source.sourceName,
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
      tier_index: pricedFact.tierIndex,
      tier_mode: pricedFact.tierMode,
      pricing_component_count: pricedFact.pricingComponentCount,
    }
  }

  private priceFactsFromCompactGrantState(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    params: {
      activeGrants: ActiveGrantInput[]
      entitlement: EntitlementConfigInput
      eventTimestamp: number
      facts: Fact[]
    }
  ): { periodWriteCount: number; pricedFacts: PricedFact[]; touchedStateCount: number } {
    const grantStates = params.facts.some((fact) => fact.delta > 0)
      ? this.readGrantStatesForActiveGrants(tx, params.activeGrants, params.eventTimestamp)
      : []
    const { pricedFacts, touchedStates } = this.priceFactsFromGrantStates({
      ...params,
      grantStates,
    })

    const periodWriteCount = this.writeGrantConsumptions(tx, touchedStates.values())

    return { periodWriteCount, pricedFacts, touchedStateCount: touchedStates.size }
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
        const deltaExplanation = computeUsagePriceDeltaExplanation({
          priceConfig: params.entitlement.featureConfig,
          usageAfter: allocation.usageAfter,
          usageBefore: allocation.usageBefore,
        })
        const amountAfterExplanation = computeUsagePriceDeltaExplanation({
          priceConfig: params.entitlement.featureConfig,
          usageAfter: allocation.usageAfter,
          usageBefore: 0,
        })

        pricedFacts.push({
          amountAfterMinor: amountAfterExplanation.amountMinor,
          amountMinor: deltaExplanation.amountMinor,
          currency: allocation.grant.currencyCode,
          fact,
          featurePlanVersionId: params.entitlement.featurePlanVersionId,
          featureSlug: params.entitlement.featureSlug,
          grantId: allocation.grant.grantId,
          periodKey: allocation.periodKey,
          pricingComponentCount: deltaExplanation.pricingComponentCount,
          tierIndex: deltaExplanation.tierIndex,
          tierMode: deltaExplanation.tierMode,
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
    const deltaExplanation = computeUsagePriceDeltaExplanation({
      priceConfig: entitlement.featureConfig,
      usageAfter,
      usageBefore,
    })
    const amountAfterExplanation = computeUsagePriceDeltaExplanation({
      priceConfig: entitlement.featureConfig,
      usageAfter,
      usageBefore: 0,
    })

    return {
      amountAfterMinor: amountAfterExplanation.amountMinor,
      amountMinor: deltaExplanation.amountMinor,
      currency: grant.currencyCode,
      fact,
      featurePlanVersionId: entitlement.featurePlanVersionId,
      featureSlug: entitlement.featureSlug,
      grantId: grant.grantId,
      periodKey: bucket.periodKey,
      pricingComponentCount: deltaExplanation.pricingComponentCount,
      tierIndex: deltaExplanation.tierIndex,
      tierMode: deltaExplanation.tierMode,
      usageAfter,
      usageBefore,
      units: fact.delta,
    }
  }

  private writeGrantConsumptions(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    states: Iterable<GrantConsumptionState>
  ): number {
    const statesByPeriod = new Map<string, GrantConsumptionState[]>()
    for (const state of states) {
      const existing = statesByPeriod.get(state.periodKey)
      if (existing) {
        existing.push(state)
      } else {
        statesByPeriod.set(state.periodKey, [state])
      }
    }

    if (statesByPeriod.size === 0) {
      return 0
    }

    const updatedAt = Date.now()
    for (const [periodKey, periodStates] of statesByPeriod.entries()) {
      const existing = tx
        .select({
          grantStatesJson: entitlementPeriodUsageTable.grantStatesJson,
        })
        .from(entitlementPeriodUsageTable)
        .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
        .get()

      const mergedStates = existing ? this.parseCompactGrantStates(existing.grantStatesJson) : []
      for (const state of periodStates) {
        this.replaceGrantConsumptionState(mergedStates, state)
      }

      const sortedStates = mergedStates.sort((left, right) =>
        left.bucketKey.localeCompare(right.bucketKey)
      )
      const grantStatesJson = JSON.stringify(sortedStates)
      const periodStartAt = Math.min(...sortedStates.map((candidate) => candidate.periodStartAt))
      const periodEndAt = Math.max(...sortedStates.map((candidate) => candidate.periodEndAt))

      if (existing) {
        tx.update(entitlementPeriodUsageTable)
          .set({
            periodStartAt,
            periodEndAt,
            grantStatesJson,
            updatedAt,
          })
          .where(eq(entitlementPeriodUsageTable.periodKey, periodKey))
          .run()
      } else {
        tx.insert(entitlementPeriodUsageTable)
          .values({
            periodKey,
            periodStartAt,
            periodEndAt,
            grantStatesJson,
            updatedAt,
          })
          .run()
      }
    }

    this.invalidateEnforcementStateCache()
    return statesByPeriod.size
  }

  private parseCompactGrantStates(raw: string): GrantConsumptionState[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.logger.warn("skipping unparsable compact entitlement period state", {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    const result = compactGrantConsumptionStateListSchema.safeParse(parsed)
    if (!result.success) {
      this.logger.warn("skipping malformed compact entitlement period state", {
        error: result.error.message,
      })
      return []
    }

    return result.data
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
    const latestPeriodUsage = this.db
      .select({ periodEndAt: entitlementPeriodUsageTable.periodEndAt })
      .from(entitlementPeriodUsageTable)
      .orderBy(desc(entitlementPeriodUsageTable.periodEndAt))
      .limit(1)
      .get()

    const lifecycleEnds: number[] = []
    if (
      typeof latestPeriodUsage?.periodEndAt === "number" &&
      Number.isFinite(latestPeriodUsage.periodEndAt)
    ) {
      lifecycleEnds.push(latestPeriodUsage.periodEndAt)
    }
    const reservationEndAt = this.readWalletReservation(this.db)?.reservationEndAt
    if (typeof reservationEndAt === "number" && Number.isFinite(reservationEndAt)) {
      lifecycleEnds.push(reservationEndAt)
    }

    return lifecycleEnds.length > 0 ? Math.max(...lifecycleEnds) : null
  }

  // Read the reservation-relevant fields in one shot. Returns `null` when
  // no reservation row exists yet (pre-first-paid-apply). A row with a null
  // `reservationId` means the DO is operating without a reservation —
  // callers must treat that as "skip wallet check".
  private readWalletReservation(
    tx: DrizzleSqliteDODatabase<typeof schema>
  ): WalletReservationSnapshot {
    const row = tx
      .select({
        projectId: walletReservationTable.projectId,
        customerId: walletReservationTable.customerId,
        currency: walletReservationTable.currency,
        reservationEndAt: walletReservationTable.reservationEndAt,
        billingPeriodId: walletReservationTable.billingPeriodId,
        cycleEndAt: walletReservationTable.cycleEndAt,
        cycleStartAt: walletReservationTable.cycleStartAt,
        featurePlanVersionItemId: walletReservationTable.featurePlanVersionItemId,
        featureSlug: walletReservationTable.featureSlug,
        statementKey: walletReservationTable.statementKey,
        reservationId: walletReservationTable.reservationId,
        allocationAmount: walletReservationTable.allocationAmount,
        consumedAmount: walletReservationTable.consumedAmount,
        flushedAmount: walletReservationTable.flushedAmount,
        consumedQuantity: walletReservationTable.consumedQuantity,
        flushedQuantity: walletReservationTable.flushedQuantity,
        refillThresholdBps: walletReservationTable.refillThresholdBps,
        refillChunkAmount: walletReservationTable.refillChunkAmount,
        targetReservationAmount: walletReservationTable.targetReservationAmount,
        spendEwmaAmount: walletReservationTable.spendEwmaAmount,
        lastRateSampledAtMs: walletReservationTable.lastRateSampledAtMs,
        maxEventCostAmount: walletReservationTable.maxEventCostAmount,
        pendingRefillAmount: walletReservationTable.pendingRefillAmount,
        pendingFlushAmount: walletReservationTable.pendingFlushAmount,
        pendingFlushQuantity: walletReservationTable.pendingFlushQuantity,
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
      billingPeriodId: row.billingPeriodId ?? null,
      cycleEndAt: row.cycleEndAt ?? null,
      cycleStartAt: row.cycleStartAt ?? null,
      featurePlanVersionItemId: row.featurePlanVersionItemId ?? null,
      featureSlug: row.featureSlug ?? null,
      statementKey: row.statementKey ?? null,
      reservationId: row.reservationId ?? null,
      allocationAmount: Number(row.allocationAmount ?? 0),
      consumedAmount: Number(row.consumedAmount ?? 0),
      flushedAmount: Number(row.flushedAmount ?? 0),
      consumedQuantity: Number(row.consumedQuantity ?? 0),
      flushedQuantity: Number(row.flushedQuantity ?? 0),
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
      pendingFlushQuantity:
        row.pendingFlushQuantity === null || row.pendingFlushQuantity === undefined
          ? null
          : Number(row.pendingFlushQuantity),
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

  private hasPendingWalletFlush(window: WalletReservationSnapshot): boolean {
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
    const readiness = this.resolveReservationGrowthReadiness(params)
    if (readiness.kind === "already_funded") {
      return { kind: "already_funded" }
    }
    if (readiness.kind === "unavailable") {
      return null
    }

    const plan = this.planReservationGrowthForCurrentEvent({
      currentRemaining: readiness.currentRemaining,
      eventTimestamp: params.eventTimestamp,
      eventCostAmount: params.cost,
      window: readiness.window,
    })
    if (!plan) {
      return null
    }

    this.requireReservationInvoiceContext(readiness.window)
    this.persistReservationGrowthIntent(plan)
    await this.requestFlushAndRefill(plan.trigger)

    return { kind: "refilled", trigger: plan.trigger }
  }

  private async growReservationForBatchHeadroom(
    params: EntitlementWindowBatchReservationUnderfundedError["params"]
  ): Promise<BatchReservationGrowthResult | null> {
    const headroom = computeBatchReservationHeadroom({
      persistedConsumedAmount: params.persistedConsumedAmount,
      stagedConsumedAmount: params.stagedConsumedAmount,
      currentEventEffectiveCostAmount: params.effectiveCostAmount,
    })
    const readiness = this.resolveReservationGrowthReadiness({
      eventId: params.eventId,
      eventTimestamp: params.eventTimestamp,
      meterKey: params.meterKey,
      meterSlug: params.meterSlug,
      reservationId: params.reservationId,
      cost: headroom.requiredHeadroomAmount,
      remaining: params.currentRemainingAmount,
    })
    if (readiness.kind === "already_funded") {
      return { kind: "already_funded" }
    }
    if (readiness.kind === "unavailable") {
      return null
    }

    const refillAmount = computeBatchReservationRefillAmount({
      currentRemainingAmount: readiness.currentRemaining,
      requiredHeadroomAmount: headroom.requiredHeadroomAmount,
      targetReservationAmount: params.targetReservationAmount,
      maxOutstandingAmount: this.reservationPolicy().maxOutstandingAmount,
    })
    if (refillAmount <= 0) {
      return { kind: "max_outstanding_reached" }
    }

    const flushSeq = readiness.window.flushSeq + 1
    const trigger: RefillTrigger = {
      flushSeq,
      flushAmount: Math.max(0, readiness.window.consumedAmount - readiness.window.flushedAmount),
      flushQuantity: Math.max(
        0,
        readiness.window.consumedQuantity - readiness.window.flushedQuantity
      ),
      refillAmount,
      effectiveAt: params.eventTimestamp,
    }

    this.requireReservationInvoiceContext(readiness.window)
    // Persist minimal flush/refill intent without full refill decision state.
    // The batch retry path does not recompute spend velocity or target reservation
    // since the headroom helpers already sized the refill amount.
    this.db
      .update(walletReservationTable)
      .set({
        refillInFlight: true,
        pendingFlushSeq: trigger.flushSeq,
        pendingFlushFinal: false,
        pendingFlushAmount: trigger.flushAmount,
        pendingFlushQuantity: trigger.flushQuantity,
        pendingRefillAmount: trigger.refillAmount,
      })
      .run()
    await this.requestFlushAndRefill(trigger)

    return { kind: "refilled", trigger }
  }

  private resolveReservationGrowthReadiness(
    params: EntitlementWindowReservationUnderfundedError["params"]
  ): ReservationGrowthReadiness {
    const window = this.readWalletReservation(this.db)
    if (
      !window?.reservationId ||
      window.reservationId !== params.reservationId ||
      !window.projectId ||
      !window.customerId ||
      window.recoveryRequired ||
      window.deletionRequested
    ) {
      return { kind: "unavailable" }
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
      return { kind: "unavailable" }
    }

    if (hasPendingFlush) {
      // A pending seq already has a persisted refill amount. Let normal
      // recovery/retry own it rather than starting a competing sync grow.
      return { kind: "unavailable" }
    }

    return {
      kind: "ready",
      currentRemaining,
      window: {
        ...window,
        customerId: window.customerId,
        projectId: window.projectId,
        reservationId: window.reservationId,
      },
    }
  }

  private planReservationGrowthForCurrentEvent(params: {
    currentRemaining: number
    eventCostAmount: number
    eventTimestamp: number
    window: IdentifiedWalletReservationSnapshot
  }): ReservationGrowthPlan | null {
    const { currentRemaining, eventCostAmount, eventTimestamp, window } = params
    const flushSeq = window.flushSeq + 1
    const flushAmount = Math.max(0, window.consumedAmount - window.flushedAmount)
    const flushQuantity = Math.max(0, window.consumedQuantity - window.flushedQuantity)
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
    const currentEventCostAmount = Math.max(0, eventCostAmount)
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

    return {
      refillDecision,
      spendVelocity,
      trigger: {
        flushSeq,
        flushAmount,
        flushQuantity,
        refillAmount,
        effectiveAt: eventTimestamp,
      },
    }
  }

  private persistReservationGrowthIntent(plan: ReservationGrowthPlan): void {
    const { refillDecision, spendVelocity, trigger } = plan
    this.db
      .update(walletReservationTable)
      .set({
        refillInFlight: true,
        pendingFlushSeq: trigger.flushSeq,
        pendingFlushFinal: false,
        pendingFlushAmount: trigger.flushAmount,
        pendingFlushQuantity: trigger.flushQuantity,
        pendingRefillAmount: trigger.refillAmount,
        targetReservationAmount: refillDecision.targetReservationAmount,
        spendEwmaAmount: spendVelocity.spendEwmaAmount,
        lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
        maxEventCostAmount: refillDecision.maxEventCostAmount,
      })
      .run()
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
          flush_quantity: trigger.flushQuantity,
          reservation_refill_requested_amount: trigger.refillAmount,
        },
      },
      async () => this.requestFlushAndRefillInner(trigger)
    )
  }

  private async requestFlushAndRefillInner(trigger: RefillTrigger): Promise<void> {
    const startTime = Date.now()
    const window = this.readWalletReservation(this.db)
    const wideEvent = this.createFlushRefillWideEvent({ trigger, window })

    try {
      const flushWindow = this.resolveFlushRefillWindow({
        trigger,
        wideEvent,
        window,
      })
      if (!flushWindow) {
        return
      }

      const capturedAmount = await this.captureFlushRefillUsage({
        trigger,
        wideEvent,
        window: flushWindow,
      })
      if (capturedAmount === null) {
        return
      }

      const grantedAmount =
        trigger.refillAmount > 0
          ? await this.extendFlushRefillReservation({
              trigger,
              wideEvent,
              window: flushWindow,
            })
          : 0
      if (grantedAmount === null) {
        return
      }

      this.finalizeSuccessfulFlushRefill({
        capturedAmount,
        grantedAmount,
        trigger,
        wideEvent,
        window: flushWindow,
      })
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

  private createFlushRefillWideEvent(params: {
    trigger: RefillTrigger
    window: WalletReservationSnapshot
  }): Record<string, unknown> {
    const { trigger, window } = params
    const wideEvent: Record<string, unknown> = {
      operation: "flush_refill",
      flush_seq: trigger.flushSeq,
      flush_amount: trigger.flushAmount,
      flush_quantity: trigger.flushQuantity,
      reservation_refill_requested_amount: trigger.refillAmount,
      reservation_id: window?.reservationId ?? null,
      project_id: window?.projectId ?? null,
      customer_id: window?.customerId ?? null,
      currency: window?.currency ?? null,
      allocation_before: window?.allocationAmount ?? null,
      consumed_before: window?.consumedAmount ?? null,
      flushed_before: window?.flushedAmount ?? null,
    }
    addLedgerAmountDisplayFields(wideEvent, window?.currency, [
      "flush_amount",
      "reservation_refill_requested_amount",
      "allocation_before",
      "consumed_before",
      "flushed_before",
    ])
    return wideEvent
  }

  private resolveFlushRefillWindow(params: {
    trigger: RefillTrigger
    wideEvent: Record<string, unknown>
    window: WalletReservationSnapshot
  }): ClosableWalletReservationSnapshot | null {
    const { trigger, wideEvent, window } = params
    if (!window?.reservationId || !window.projectId || !window.customerId) {
      this.logger.error("flush+refill requested without a reservation", {
        flushSeq: trigger.flushSeq,
        flushAmount: trigger.flushAmount,
        refillAmount: trigger.refillAmount,
      })
      this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
      wideEvent.outcome = "no_reservation"
      return null
    }

    return {
      ...window,
      customerId: window.customerId,
      projectId: window.projectId,
      reservationId: window.reservationId,
    }
  }

  private finalizeSuccessfulFlushRefill(params: {
    capturedAmount: number
    grantedAmount: number
    trigger: RefillTrigger
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): void {
    const { capturedAmount, grantedAmount, trigger, wideEvent, window } = params
    this.db
      .update(walletReservationTable)
      .set({
        allocationAmount: window.allocationAmount + grantedAmount,
        flushedAmount: window.flushedAmount + capturedAmount,
        flushedQuantity: window.flushedQuantity + trigger.flushQuantity,
        flushSeq: trigger.flushSeq,
        pendingFlushSeq: null,
        pendingFlushFinal: false,
        pendingFlushAmount: null,
        pendingFlushQuantity: null,
        pendingRefillAmount: 0,
        refillInFlight: false,
        lastFlushedAt: Date.now(),
      })
      .run()

    wideEvent.reservation_refill_granted_amount = grantedAmount
    wideEvent.reservation_refill_partial =
      trigger.refillAmount > 0 && grantedAmount < trigger.refillAmount
    wideEvent.granted_amount = grantedAmount
    wideEvent.flushed_amount = capturedAmount
    wideEvent.flushed_quantity = trigger.flushQuantity
    wideEvent.allocation_after = window.allocationAmount + grantedAmount
    wideEvent.flushed_after = window.flushedAmount + capturedAmount
    wideEvent.outcome = "success"
    addLedgerAmountDisplayFields(wideEvent, window.currency, [
      "reservation_refill_granted_amount",
      "granted_amount",
      "flushed_amount",
      "allocation_after",
      "flushed_after",
    ])
  }

  private async captureFlushRefillUsage(params: {
    trigger: RefillTrigger
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<number | null> {
    const { trigger, wideEvent, window } = params
    const durableObjectId = this.ctx.id.toString()
    const invoiceContext = this.requireReservationInvoiceContext(window)
    const captureResult = await this.getWalletService().captureReservationUsage({
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      flushSeq: trigger.flushSeq,
      amount: trigger.flushAmount,
      billingPeriodId: invoiceContext.billingPeriodId,
      kind: "usage",
      statementKey: invoiceContext.statementKey,
      metadata: {
        billing_period_id: invoiceContext.billingPeriodId,
        cycle_end_at: invoiceContext.cycleEndAt,
        cycle_start_at: invoiceContext.cycleStartAt,
        feature_plan_version_item_id: invoiceContext.featurePlanVersionItemId,
        feature_slug: invoiceContext.featureSlug,
        quantity: trigger.flushQuantity,
        source_id: invoiceContext.sourceId,
        requestedBy: "durable_object",
        requestedById: durableObjectId,
        durableObjectId,
        durable_object_id: durableObjectId,
        reservation_id: window.reservationId,
        flush_seq: trigger.flushSeq,
      },
      sourceId: invoiceContext.sourceId,
    })

    if (captureResult.err) {
      this.markFlushRefillWalletError({
        context: "flush+refill capture failed",
        error: captureResult.err,
        flushSeq: trigger.flushSeq,
        reservationId: window.reservationId,
        wideEvent,
      })
      return null
    }

    return captureResult.val.capturedAmount
  }

  private async extendFlushRefillReservation(params: {
    trigger: RefillTrigger
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<number | null> {
    const { trigger, wideEvent, window } = params
    const durableObjectId = this.ctx.id.toString()
    const extendResult = await this.getWalletService().extendReservation({
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
      this.markFlushRefillWalletError({
        context: "flush+refill extend failed",
        error: extendResult.err,
        flushSeq: trigger.flushSeq,
        reservationId: window.reservationId,
        wideEvent,
      })
      return null
    }

    return extendResult.val.grantedAmount
  }

  private markFlushRefillWalletError(params: {
    context: string
    error: Error
    flushSeq: number
    reservationId: string
    wideEvent: Record<string, unknown>
  }): void {
    const { context, error, flushSeq, reservationId, wideEvent } = params
    this.logger.error(error, {
      context,
      flushSeq,
      reservationId,
    })
    // Clear the single-flight flag so apply() can re-trigger on the
    // next event; leave pendingFlushSeq set so crash recovery picks up
    // the same seq after an eviction.
    this.db.update(walletReservationTable).set({ refillInFlight: false }).run()
    wideEvent.outcome = "wallet_error"
    wideEvent.error_message = error.message
  }

  // Looks up a previously committed idempotency result for this event id.
  // Used to short-circuit retries before any wallet I/O — the in-tx check
  // in apply() catches concurrent retries that race past this read.
  private lookupCachedIdempotencyResult(eventId: string): ApplyResult | null {
    const batchEntry = this.getBatchIdempotencyResults().get(eventId)
    if (!batchEntry) return null

    return idempotencyEntryToApplyResult(batchEntry)
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

      const parsed = batchIdempotencyEntryListSchema.safeParse(rawEntries)
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

  private recordBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void {
    if (entries.length === 0) {
      return
    }

    const results = this.getBatchIdempotencyResults()
    for (const entry of entries) {
      results.set(entry.eventId, entry)
    }
  }

  private persistDeniedApplyResult(params: {
    closeReason?: ReservationCloseReason
    createdAt: number
    deniedReason?: DeniedReason
    idempotencyKey: string
    message?: string
  }): ApplyResult {
    const deniedResult: ApplyResult = { allowed: false }
    if (params.deniedReason) {
      deniedResult.deniedReason = params.deniedReason
    }
    if (params.message) {
      deniedResult.message = params.message
    }

    this.persistBatchIdempotencyResult({
      eventId: params.idempotencyKey,
      createdAt: params.createdAt,
      allowed: false,
      deniedReason: deniedResult.deniedReason ?? null,
      denyMessage: deniedResult.message ?? null,
      meterFacts: [],
    })

    if (params.closeReason) {
      this.ctx.waitUntil(this.closeReservation({ closeReason: params.closeReason }))
    }

    return deniedResult
  }

  private persistBatchIdempotencyResult(entry: BatchIdempotencyEntry): void {
    this.writeBatchIdempotencyResults(this.db, [entry])
    this.recordBatchIdempotencyResults([entry])
    this.schedulePostCommitAlarm()
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

    const plan = this.createReservationBootstrapPlan({
      activeGrants,
      input,
      meter,
      projectedCost,
    })
    if (!plan) return null

    const invoiceContext = this.resolveReservationInvoiceContext(input)
    const durableObjectId = this.ctx.id.toString()
    const result = await this.getWalletService().createReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: meter.currency as Currency,
      entitlementId: input.entitlement.customerEntitlementId,
      requestedAmount: plan.sizing.requestedAmount,
      refillThresholdBps: plan.policy.refillThresholdBps,
      refillChunkAmount: 0,
      periodStartAt: new Date(plan.bucket.start),
      periodEndAt: new Date(plan.bucket.end),
      effectiveAt: new Date(input.event.timestamp),
      metadata: {
        requestedBy: "durable_object",
        requestedById: durableObjectId,
        durableObjectId,
        meterKey: meter.key,
        customerEntitlementId: input.entitlement.customerEntitlementId,
        featureSlug: input.entitlement.featureSlug,
        eventSlug: meter.config.eventSlug,
        idempotencyKey: plan.idempotencyKey,
      },
      // The (project, entitlement, period_start) unique index is the real
      // dedupe — this key just tags ledger entries for traceability.
      idempotencyKey: plan.idempotencyKey,
    })

    if (result.err) {
      const errorFields: Record<string, unknown> = {
        context: "lazy reservation bootstrap failed",
        customer_id: input.customerId,
        project_id: input.projectId,
        customer_entitlement_id: input.entitlement.customerEntitlementId,
        currency: meter.currency,
        reservation_idempotency_key: plan.idempotencyKey,
        requested_amount: plan.sizing.requestedAmount,
        projected_cost_minor: projectedCost,
      }
      addLedgerAmountDisplayFields(errorFields, meter.currency, [
        "requested_amount",
        "projected_cost_minor",
      ])
      this.logger.error(result.err, errorFields)
      throw result.err
    }

    this.persistBootstrapReservation({
      input,
      invoiceContext,
      meter,
      plan,
      projectedCost,
      reservation: result.val,
    })

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

  private createReservationBootstrapPlan(params: {
    activeGrants: ActiveGrantInput[]
    input: ApplyInput
    meter: MeterIdentity
    projectedCost: number
  }): ReservationBootstrapPlan | null {
    const { activeGrants, input, meter, projectedCost } = params
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

    const reservationGrant = this.firstGrantByDrainOrder(activeGrants)
    const bucket = computeGrantPeriodBucket(reservationGrant, input.event.timestamp)
    if (!bucket) {
      throw new Error("Unable to resolve grant bucket for reservation bootstrap")
    }

    return {
      bucket,
      idempotencyKey: `do_lazy:${meter.customerEntitlementId}:${bucket.periodKey}`,
      policy,
      sampledAtMs: Date.now(),
      sizing,
    }
  }

  private persistBootstrapReservation(params: {
    input: ApplyInput
    invoiceContext: ReservationInvoiceContext
    meter: MeterIdentity
    plan: ReservationBootstrapPlan
    projectedCost: number
    reservation: CreateReservationOutput
  }): void {
    const { input, invoiceContext, meter, plan, projectedCost, reservation } = params
    this.ensureMeterState(this.db, {
      meterKey: meter.key,
      createdAt: Date.now(),
    })
    this.ensureWalletReservation(this.db, {
      projectId: input.projectId,
      customerId: input.customerId,
      currency: meter.currency,
      reservationEndAt: plan.bucket.end,
      billingPeriodId: invoiceContext.billingPeriodId,
      cycleEndAt: invoiceContext.cycleEndAt,
      cycleStartAt: invoiceContext.cycleStartAt,
      featurePlanVersionItemId: invoiceContext.featurePlanVersionItemId,
      featureSlug: invoiceContext.featureSlug,
      statementKey: invoiceContext.statementKey,
    })

    // For a reused active reservation, only refresh the columns that
    // concern wallet enforcement; preserve consumedAmount/flushedAmount/
    // flushSeq because the existing flush bookkeeping is still in flight.
    // For a fresh reservation, reset the bookkeeping to zero.
    const reservationUpdate =
      reservation.reused === "active"
        ? {
            reservationId: reservation.reservationId,
            allocationAmount: reservation.allocationAmount,
            refillThresholdBps: plan.policy.refillThresholdBps,
            refillChunkAmount: 0,
            targetReservationAmount: plan.sizing.targetReservationAmount,
            spendEwmaAmount: 0,
            lastRateSampledAtMs: plan.sampledAtMs,
            maxEventCostAmount: projectedCost,
          }
        : {
            reservationId: reservation.reservationId,
            allocationAmount: reservation.allocationAmount,
            consumedAmount: 0,
            flushedAmount: 0,
            consumedQuantity: 0,
            flushedQuantity: 0,
            flushSeq: 0,
            pendingFlushSeq: null,
            pendingFlushFinal: false,
            pendingFlushAmount: null,
            pendingFlushQuantity: null,
            pendingRefillAmount: 0,
            refillThresholdBps: plan.policy.refillThresholdBps,
            refillChunkAmount: 0,
            targetReservationAmount: plan.sizing.targetReservationAmount,
            spendEwmaAmount: 0,
            lastRateSampledAtMs: plan.sampledAtMs,
            maxEventCostAmount: projectedCost,
            refillInFlight: false,
          }

    this.db.update(walletReservationTable).set(reservationUpdate).run()
  }

  private resolveReservationInvoiceContext(input: ApplyInput): ReservationInvoiceContext {
    const billingPeriod = input.entitlement.billingPeriods.find(
      (period) =>
        period.cycleStartAt <= input.event.timestamp && input.event.timestamp < period.cycleEndAt
    )

    if (!billingPeriod) {
      throw new Error(
        `Missing billing period invoice context for entitlement ${input.entitlement.customerEntitlementId} at ${input.event.timestamp}`
      )
    }

    return {
      billingPeriodId: billingPeriod.billingPeriodId,
      cycleEndAt: billingPeriod.cycleEndAt,
      cycleStartAt: billingPeriod.cycleStartAt,
      featurePlanVersionItemId: billingPeriod.featurePlanVersionItemId,
      featureSlug: input.entitlement.featureSlug,
      sourceId: `${billingPeriod.billingPeriodId}:${billingPeriod.featurePlanVersionItemId}`,
      statementKey: billingPeriod.statementKey,
    }
  }

  private refreshWalletReservationInvoiceContextIfMissing(
    tx: DrizzleSqliteDODatabase<typeof schema>,
    input: ApplyInput,
    window: WalletReservationSnapshot
  ): WalletReservationSnapshot {
    if (!window?.reservationId || !this.isReservationInvoiceContextMissing(window)) {
      return window
    }

    const invoiceContext = this.resolveReservationInvoiceContext(input)
    const patch = {
      billingPeriodId: invoiceContext.billingPeriodId,
      cycleEndAt: invoiceContext.cycleEndAt,
      cycleStartAt: invoiceContext.cycleStartAt,
      featurePlanVersionItemId: invoiceContext.featurePlanVersionItemId,
      featureSlug: invoiceContext.featureSlug,
      statementKey: invoiceContext.statementKey,
    }

    tx.update(walletReservationTable).set(patch).run()

    return {
      ...window,
      ...patch,
    }
  }

  private isReservationInvoiceContextMissing(
    window: Pick<
      NonNullable<WalletReservationSnapshot>,
      | "billingPeriodId"
      | "cycleEndAt"
      | "cycleStartAt"
      | "featurePlanVersionItemId"
      | "featureSlug"
      | "statementKey"
    >
  ): boolean {
    return (
      !window.billingPeriodId ||
      window.cycleEndAt === null ||
      window.cycleStartAt === null ||
      !window.featurePlanVersionItemId ||
      !window.featureSlug ||
      !window.statementKey
    )
  }

  private requireReservationInvoiceContext(
    window: Pick<
      NonNullable<WalletReservationSnapshot>,
      | "billingPeriodId"
      | "cycleEndAt"
      | "cycleStartAt"
      | "featurePlanVersionItemId"
      | "featureSlug"
      | "reservationId"
      | "statementKey"
    >
  ): ReservationInvoiceContext {
    const {
      billingPeriodId,
      cycleEndAt,
      cycleStartAt,
      featurePlanVersionItemId,
      featureSlug,
      statementKey,
    } = window

    if (
      !billingPeriodId ||
      cycleEndAt === null ||
      cycleStartAt === null ||
      !featurePlanVersionItemId ||
      !featureSlug ||
      !statementKey
    ) {
      throw new Error(
        `Wallet reservation ${window.reservationId} is missing billing invoice context`
      )
    }

    return {
      billingPeriodId,
      cycleEndAt,
      cycleStartAt,
      featurePlanVersionItemId,
      featureSlug,
      sourceId: `${billingPeriodId}:${featurePlanVersionItemId}`,
      statementKey,
    }
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
        const numericValue = readNumericEventField(meter.config, input.event)
        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: numericValue,
          valueAfter: previousValue + numericValue,
        }
      }
      case "max": {
        const numericValue = readNumericEventField(meter.config, input.event)
        const nextValue = row ? Math.max(previousValue, numericValue) : numericValue
        return {
          eventId: input.event.id,
          meterKey: meter.key,
          delta: nextValue - previousValue,
          valueAfter: nextValue,
        }
      }
      case "latest": {
        const numericValue = readNumericEventField(meter.config, input.event)
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

  private schedulePostCommitAlarm(): void {
    this.ctx.waitUntil(this.scheduleAlarm(Date.now() + FLUSH_INTERVAL_MS))
  }
}
