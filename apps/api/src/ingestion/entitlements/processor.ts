import type { Currency, OverageStrategy } from "@unprice/db/validators"
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
  computeGrantPeriodBucket,
  computeMaxMarginalPriceMinor,
  computeUsagePriceDeltaExplanation,
  computeUsagePriceDeltaMinor,
  consumeGrantsByPriority,
  resolveActiveGrants,
  resolveAvailableGrantUnits,
  resolveConsumedGrantUnits,
} from "@unprice/services/entitlements"
import type { CreateReservationOutput, ReservationCloseReason } from "@unprice/services/wallet"
import {
  DEFAULT_RESERVATION_POLICY,
  type InitialReservationDecision,
  type ReservationPolicy,
  computeInitialReservation,
  computeRefillDecision,
  computeSyncGrowRefillAmount,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import {
  type OptimizedBatchWalletDiagnostics,
  type OptimizedBatchWalletRetryOutcome,
  type SingleApplyExecutionMetrics,
  addLedgerAmountDisplayFields,
  batchWalletDiagnosticsLogFields,
  createOptimizedBatchWalletDiagnostics,
  createSingleApplyExecutionMetrics,
  readLogCurrency,
  recordBatchWalletUnderfundedRetry,
} from "./apply-telemetry"
import {
  buildBatchEventApplyInput,
  computeBatchReservationHeadroom,
  computeBatchReservationRefillAmount,
  createAllowedBatchOutcome,
  createCachedBatchResult,
  createDeniedBatchOutcome,
  planWalletReservationSpend,
} from "./batch-apply-helpers"
import { FLUSH_INTERVAL_MS, IDEMPOTENCY_CLEANUP_INTERVAL_MS } from "./constants"
import {
  type ActiveGrantInput,
  type ApplyBatchInput,
  type ApplyBatchInternalResult,
  type ApplyBatchResultRow,
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
  createApplyBatchMetrics,
  enforcementStateInputSchema,
} from "./contracts"
import {
  replaceGrantConsumptionState,
  selectGrantStatesForActiveGrants,
} from "./entitlement-window-store"
import {
  extractCurrencyCodeFromFeatureConfig,
  readNumericEventField,
  resolveMeterIdentity,
} from "./meter-helpers"
import { InMemoryMeterStorageAdapter, type MeterStateDraft } from "./meter-state-adapter"
import {
  type OptimizedBatchDraft,
  type OptimizedBatchWriteMetrics,
  createOptimizedBatchDraft,
} from "./optimized-batch-draft"
import type {
  EntitlementWindowClock,
  EntitlementWindowInstrumentation,
  EntitlementWindowProcessorDeps,
  EntitlementWindowRuntime,
  EntitlementWindowScheduler,
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
  EntitlementWindowTimingConfig,
  EntitlementWindowWalletOps,
  EntitlementWindowWalletProvider,
} from "./ports"
import { unique } from "./utils"
import {
  type ReservationInvoiceContext,
  hasPendingWalletFlush,
  isReservationInvoiceContextMissing,
  requireReservationInvoiceContext,
} from "./wallet-reservation-flow"

type OptimizedBatchSetup = {
  cachedResults: Map<string, BatchIdempotencyEntry>
  entitlement: EntitlementConfigInput
  grants: ActiveGrantInput[]
  grantStates: GrantConsumptionState[]
  meter: MeterIdentity
  meterState: MeterStateDraft
  wallet: WalletReservationSnapshot
}

type OptimizedBatchOptions = {
  refillAttemptedEventIds: ReadonlySet<string>
  walletDiagnostics?: OptimizedBatchWalletDiagnostics
}

type BatchReservationGrowthResult = ReservationGrowthResult | { kind: "max_outstanding_reached" }

class ExternalReservationBudgetExceededError extends Error {
  constructor(
    readonly totalCost: number,
    readonly remainingAmount: number
  ) {
    super(`Priced cost ${totalCost} exceeds run remaining amount ${remainingAmount}`)
    this.name = "ExternalReservationBudgetExceededError"
  }
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

/**
 * Backend-neutral entitlement window orchestrator. Owns apply/applyBatch,
 * enforcement reads, wallet reservation lifecycle (bootstrap, spend, refill,
 * close, crash recovery), idempotency replay, and alarm lifecycle decisions.
 * Talks to the host platform exclusively through the ports in ./ports.ts —
 * the Cloudflare Durable Object adapter (EntitlementWindowDO) is one wiring;
 * a Redis-backed store/scheduler/runtime would be another.
 */
export class EntitlementWindowProcessor {
  private readonly clock: EntitlementWindowClock
  private readonly instrument: EntitlementWindowInstrumentation
  private readonly logger: Logger
  private readonly runtime: EntitlementWindowRuntime
  private readonly scheduler: EntitlementWindowScheduler
  private readonly store: EntitlementWindowStateStore
  private readonly timing: EntitlementWindowTimingConfig
  private readonly wallet: EntitlementWindowWalletProvider

  private nextAlarmAt: number | null = null
  private lastIdempotencyCleanupAt: number | null = null
  private enforcementStateCache: EnforcementStateCache | null = null
  // In-memory single-flight for lazy reservation bootstrap. It only dedupes
  // external wallet I/O while this window instance is alive; the reservation
  // row remains the durable source of truth.
  private reservationBootstrapPromise: Promise<ApplyResult | null> | null = null

  constructor(deps: EntitlementWindowProcessorDeps) {
    this.clock = deps.clock
    this.instrument = deps.instrument
    this.logger = deps.logger
    this.runtime = deps.runtime
    this.scheduler = deps.scheduler
    this.store = deps.store
    this.timing = deps.timing
    this.wallet = deps.wallet
  }

  /**
   * Run once per window wake, after the store is migrated/hydrated and before
   * the first command. Restores the alarm watermark and replays any wallet
   * flush that was interrupted by an eviction/crash.
   */
  public async initialize(): Promise<void> {
    this.nextAlarmAt = await this.scheduler.getAlarm()

    // Crash recovery. If the window was evicted mid-flush, the store still
    // carries `pending_flush_seq > flush_seq`. Re-issue the flush with the
    // same seq — WalletService dedupes via the ledger
    // idempotency key `flush:{reservationId}:{flushSeq}`, so a duplicate
    // call after a successful commit is a no-op. Newer events accepted
    // after the pending seq was created must wait for the next seq, so
    // replays use the persisted pending amount and quantity.
    const window = this.store.readWalletReservation()
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
        this.runtime.waitUntil(
          this.closeReservation({ closeReason: "manual", recoverPendingFinal: true })
        )
      } else {
        // Retry the same refill amount recorded when pendingFlushSeq was
        // created. Recomputing adaptive policy here could change the refill
        // leg behind the same wallet idempotency key.
        this.runtime.waitUntil(
          this.requestFlushAndRefill({
            flushSeq: window.pendingFlushSeq,
            flushAmount,
            flushQuantity,
            refillAmount: window.pendingRefillAmount,
            effectiveAt: this.clock.now(),
          })
        )
      }
    }
  }

  public async apply(rawInput: ApplyInput): Promise<ApplyResult> {
    return this.instrument("apply", async () => this.applyInner(rawInput))
  }

  public async applyBatch(rawInput: ApplyBatchInput): Promise<{
    results: ApplyBatchResultRow[]
  }> {
    return this.instrument("apply_batch", async () => {
      const startTime = this.clock.now()
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
          const optimized = await this.applyBatchWithCompactDraft(input)
          metrics = optimized.metrics
          results.push(...optimized.results)
          return { results: optimized.results }
        } catch (error) {
          if (error instanceof EntitlementWindowBatchReservationBootstrapRequired) {
            const eventInput = buildBatchEventApplyInput(input, error.params.event)
            // Grants and meter identity come from the request, not storage —
            // the bootstrap retry needs no store reads.
            const activeGrants = resolveActiveGrants(input.grants, error.params.event.timestamp)
            const denial = await this.bootstrapReservationForProjectedCost({
              activeGrants,
              input: eventInput,
              meter: resolveMeterIdentity(input.entitlement),
              projectedCost: error.params.projectedCost,
            })

            if (denial) {
              throw new Error(`Batch reservation bootstrap denied: ${denial.deniedReason}`)
            }

            reservationAction = "bootstrapped"
            const retry = await this.applyBatchWithCompactDraft(input)
            metrics = retry.metrics
            results.push(...retry.results)
            return { results: retry.results }
          }

          if (error instanceof EntitlementWindowBatchReservationUnderfundedError) {
            const refillAttemptedEventIds = new Set<string>()
            let underfundedError = error

            for (let attempt = 0; attempt < input.events.length; attempt++) {
              const growth = await this.growReservationForBatchHeadroom(underfundedError.params)
              const growthOutcome: OptimizedBatchWalletRetryOutcome = growth?.kind ?? "unavailable"
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
                const retry = await this.applyBatchWithCompactDraft(input, {
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
          duration_ms: this.clock.now() - startTime,
          outcome: thrown ? "error" : "success",
          error_type: thrown instanceof Error ? thrown.name : undefined,
          error_message: thrown instanceof Error ? thrown.message : undefined,
        }

        this.logger.info("entitlement apply_batch", batchEvent)
      }
    })
  }

  private prepareOptimizedBatch(
    input: ApplyBatchInput,
    createdAt: number,
    idempotencyKeys: string[]
  ): OptimizedBatchSetup {
    const entitlement = input.entitlement
    const grants = input.grants
    const meter = resolveMeterIdentity(entitlement)

    return this.store.atomically((tx) => {
      return {
        cachedResults: tx.lookupCachedIdempotencyResults(idempotencyKeys),
        entitlement,
        grantStates: tx.readGrantStatesForBatch(
          grants,
          input.events.map((event) => event.timestamp)
        ),
        grants,
        meter,
        meterState: tx.readMeterStateDraft(meter.key, createdAt),
        wallet: tx.readWalletReservation(),
      }
    })
  }

  private async applyBatchWithCompactDraft(
    input: ApplyBatchInput,
    options: OptimizedBatchOptions = { refillAttemptedEventIds: new Set() }
  ): Promise<ApplyBatchInternalResult> {
    const createdAt = this.clock.now()
    const idempotencyKeys = unique(input.events.map((event) => event.idempotencyKey))
    const setup = this.prepareOptimizedBatch(input, createdAt, idempotencyKeys)
    const state = createOptimizedBatchDraft({
      grantStates: setup.grantStates,
      meterState: setup.meterState,
      wallet: setup.wallet,
    })

    for (const event of input.events) {
      await this.stageBatchEventIntoDraft({
        createdAt,
        event,
        input,
        options,
        setup,
        state,
      })
    }

    const commit = state.toCommitPayload()
    Object.assign(
      state.metrics,
      this.commitCompactBatchDraft({
        createdAt,
        idempotencyEntries: commit.idempotencyEntries,
        meter: setup.meter,
        meterState: commit.meterState,
        touchedGrantStates: commit.touchedGrantStates,
        wallet: commit.wallet,
        walletDirty: commit.walletDirty,
      })
    )

    if (state.refillTrigger) {
      this.runtime.waitUntil(this.requestFlushAndRefill(state.refillTrigger))
    }

    if (state.reservationCloseReason) {
      this.runtime.waitUntil(this.closeReservation({ closeReason: state.reservationCloseReason }))
    }

    return { results: state.results, metrics: state.metrics }
  }

  private async stageBatchEventIntoDraft(params: {
    createdAt: number
    event: ApplyBatchInput["events"][number]
    input: ApplyBatchInput
    options: OptimizedBatchOptions
    setup: OptimizedBatchSetup
    state: OptimizedBatchDraft
  }): Promise<void> {
    const { createdAt, event, input, options, setup, state } = params
    const activeGrants = resolveActiveGrants(setup.grants, event.timestamp)

    if (activeGrants.length === 0) {
      throw new Error("No active grants found for event timestamp")
    }

    const cached =
      state.lookupStagedResult(event.idempotencyKey) ??
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
        this.store,
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

    const pricedFacts = this.stageMeterAndPriceFactsIntoDraft({
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

  private stageMeterAndPriceFactsIntoDraft(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    input: ApplyBatchInput
    setup: OptimizedBatchSetup
    state: OptimizedBatchDraft
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
    state: OptimizedBatchDraft
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
    state.stageIdempotencyEntry(allowed.entry)
    state.results.push(allowed.result)
  }

  private async ensureOptimizedBatchWalletBootstrap(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    event: ApplyBatchInput["events"][number]
    eventInput: ApplyInput
    setup: OptimizedBatchSetup
    state: OptimizedBatchDraft
    usesWalletReservation: boolean
  }): Promise<boolean> {
    const { activeGrants, createdAt, event, eventInput, setup, state, usesWalletReservation } =
      params
    const needsBootstrap =
      usesWalletReservation && (!state.wallet || state.wallet.reservationId === null)

    if (!needsBootstrap) {
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

    if (state.hasDurableMutations()) {
      throw new EntitlementWindowBatchReservationBootstrapRequired({
        event,
        projectedCost,
      })
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

    state.wallet = this.store.readWalletReservation()
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
    state: OptimizedBatchDraft
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
    state: OptimizedBatchDraft
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
          states: selectGrantStatesForActiveGrants(
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
    state: OptimizedBatchDraft
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
        requireReservationInvoiceContext(wallet)
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

  private stageOptimizedBatchDeniedResult(params: {
    createdAt: number
    deniedReason?: DeniedReason
    event: ApplyBatchInput["events"][number]
    message?: string
    state: OptimizedBatchDraft
  }): ApplyBatchResultRow {
    const { createdAt, deniedReason, event, message, state } = params
    const denied = createDeniedBatchOutcome({
      correlationKey: event.correlationKey,
      createdAt,
      deniedReason,
      idempotencyKey: event.idempotencyKey,
      message,
    })
    state.stageIdempotencyEntry(denied.entry)
    state.results.push(denied.result)
    return denied.result
  }

  private commitCompactBatchDraft(params: {
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
    // synchronous store transaction. No await belongs inside this block.
    this.store.atomically((tx) => {
      if (params.meterState.dirty) {
        tx.writeMeterState({
          meterKey: params.meter.key,
          createdAt: params.meterState.createdAt,
          usage: params.meterState.usage,
          updatedAt: params.meterState.updatedAt,
        })
      }

      tx.writeGrantConsumptions(params.touchedGrantStates.values())

      tx.writeBatchIdempotencyResults(params.idempotencyEntries)

      if (params.walletDirty && params.wallet) {
        tx.updateWalletReservation({
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
      }
    })

    this.store.recordBatchIdempotencyResults(params.idempotencyEntries)
    this.invalidateEnforcementStateCache()
    this.schedulePostCommitAlarm()

    return writeMetrics
  }

  private async applyInner(
    rawInput: ApplyInput,
    options: ApplyInnerOptions = {}
  ): Promise<ApplyResult> {
    const startTime = this.clock.now()
    const input = applyInputSchema.parse(rawInput)
    const idempotencyKey = input.idempotencyKey
    const createdAt = this.clock.now()
    const wallet = input.wallet ?? { mode: "standard" as const }
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
    wideEvent.wallet_mode = wallet.mode

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

      if (wallet.mode === "external_reservation") {
        const externalResult = this.executeSingleApplyExternalReservation({
          activeGrants,
          createdAt,
          entitlement,
          idempotencyKey,
          input,
          meter,
          metrics,
          overageStrategy,
          remainingAmount: wallet.remainingAmount,
        })
        result = externalResult
        return externalResult
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

  // External reservation mode: prices the event and enforces entitlement limits
  // but does NOT create/manage wallet reservations. Instead, it compares the
  // priced cost against the caller-provided remaining amount.
  // Used by RunBudgetDO which manages its own run-level budget.
  private executeSingleApplyExternalReservation(params: {
    activeGrants: ActiveGrantInput[]
    createdAt: number
    entitlement: EntitlementConfigInput
    idempotencyKey: string
    input: ApplyInput
    meter: MeterIdentity
    metrics: SingleApplyExecutionMetrics
    overageStrategy: OverageStrategy
    remainingAmount: number
  }): ApplyResult {
    const {
      activeGrants,
      createdAt,
      entitlement,
      idempotencyKey,
      input,
      meter,
      metrics,
      overageStrategy,
      remainingAmount,
    } = params

    try {
      return this.store.atomically((tx) => {
        // Double-check idempotency inside the transaction
        const cachedResult = tx.lookupCachedIdempotencyResult(idempotencyKey)
        if (cachedResult) {
          metrics.duplicateCount = 1
          return cachedResult
        }

        // Apply the meter event and price it (same as standard mode)
        let pricedFacts: PricedFact[]
        try {
          pricedFacts = this.applyAndPriceSingleApplyEvent(tx, {
            activeGrants,
            createdAt,
            entitlement,
            input,
            meter,
            metrics,
            overageStrategy,
          })
        } catch (error) {
          if (error instanceof EntitlementWindowLimitExceededError) {
            const deniedResult = this.persistDeniedApplyResult(
              {
                idempotencyKey,
                createdAt,
                deniedReason: "LIMIT_EXCEEDED",
                message: error.message,
              },
              tx
            )
            metrics.idempotencyInsertCount = 1
            return deniedResult
          }
          throw error
        }

        // Compare priced cost against external reservation remaining amount
        const totalCost = pricedFacts.reduce((sum, { amountMinor }) => sum + amountMinor, 0)

        if (totalCost > remainingAmount) {
          throw new ExternalReservationBudgetExceededError(totalCost, remainingAmount)
        }

        // Build meter facts and persist allowed result (no wallet I/O)
        const meterFacts = pricedFacts.map((pricedFact) =>
          this.buildMeterFactPayload({
            createdAt,
            input,
            meter,
            pricedFact,
          })
        )

        const idempotencyEntry = this.persistAllowedSingleApplyResult(tx, {
          createdAt,
          idempotencyKey,
          meterFacts,
          metrics,
        })

        this.store.recordBatchIdempotencyResults([idempotencyEntry])
        this.schedulePostCommitAlarm()

        return { allowed: true, meterFacts } as ApplyResult
      })
    } catch (error) {
      if (error instanceof ExternalReservationBudgetExceededError) {
        const deniedResult = this.persistDeniedApplyResult({
          idempotencyKey,
          createdAt,
          deniedReason: "RUN_BUDGET_EXCEEDED",
          message: error.message,
        })
        metrics.idempotencyInsertCount = 1
        return deniedResult
      }
      throw error
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
    const cachedResult = this.store.lookupCachedIdempotencyResult(idempotencyKey)
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
    // Lazy reservation bootstrap. If this window has never opened a reservation
    // for the current period, only open one when the current event produces a
    // positive priced delta. Free-tier events stay off the wallet path; the
    // first paid boundary-crossing event bootstraps the wallet.
    //
    // Outside the atomic boundary because the wallet ledger and the window
    // store cannot share a single transaction. A small in-memory single-flight
    // prevents duplicate wallet calls while this instance is awaiting external
    // I/O.
    const preWindow = this.store.readWalletReservation()
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
    // without re-calling the wallet. The window's normal denial-cache pattern.
    const deniedResult = this.persistDeniedApplyResult({
      idempotencyKey,
      createdAt,
      deniedReason: denial.deniedReason,
      message: denial.message,
    })
    metrics.idempotencyInsertCount = 1
    return { result: deniedResult, usesWalletReservation }
  }

  private prepareSingleApplyContext(input: ApplyInput, _createdAt: number): SingleApplyContext {
    const activeGrants = resolveActiveGrants(input.grants, input.event.timestamp)

    if (activeGrants.length === 0) {
      throw new Error("No active grants found for event timestamp")
    }

    return {
      activeGrants,
      creditLinePolicy: input.entitlement.creditLinePolicy,
      entitlement: input.entitlement,
      meter: resolveMeterIdentity(input.entitlement),
      overageStrategy: input.entitlement.overageStrategy,
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
    wideEvent.duration_ms = this.clock.now() - startTime

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
          this.store.recordBatchIdempotencyResults([txResult.idempotencyEntry])
          this.schedulePostCommitAlarm()
        }

        // Flush+refill must happen after commit so the new consumed/refill
        // state is visible to `requestFlushAndRefill`, and must outlive the
        // request via `runtime.waitUntil` so it continues after apply() returns.
        if (metrics.refillTrigger) {
          this.runtime.waitUntil(this.requestFlushAndRefill(metrics.refillTrigger))
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

    return this.store.atomically((tx) => {
      const cachedResult = tx.lookupCachedIdempotencyResult(idempotencyKey)
      if (cachedResult) {
        metrics.duplicateCount = 1
        return {
          idempotencyEntry: null,
          result: cachedResult,
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
    tx: EntitlementWindowStateOps,
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
    tx: EntitlementWindowStateOps,
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
    // this window. Without a reservation the window operates without local
    // allocation tracking or refill triggers.
    const window = this.refreshWalletReservationInvoiceContextIfMissing(
      tx,
      input,
      tx.readWalletReservation()
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
    tx: EntitlementWindowStateOps,
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

    tx.updateWalletReservation({ lastEventAt: createdAt })
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
    tx: EntitlementWindowStateOps
  }): { facts: Fact[]; meterState: MeterStateDraft } {
    const { activeGrants, createdAt, entitlement, input, meter, metrics, overageStrategy, tx } =
      params
    const meterState = tx.readMeterStateDraft(meter.key, createdAt)
    const adapter = new InMemoryMeterStorageAdapter(meterState)
    // The engine persists only raw aggregation state through its adapter.
    // Entitlement usage is written below into compact period state.
    const engine = new AsyncMeterAggregationEngine([meter.config], adapter, input.now)

    const facts = engine.applyEventSync(input.event, {
      // A limit hit is still a valid ingestion event. We store the denied
      // result in the window idempotency table so queue retries stay stable,
      // while the ingestion service treats the event as processed.
      beforePersist: (pendingFacts) => {
        if (!input.enforceLimit) {
          return
        }

        const exceeded = this.findGrantLimitExceededFact({
          activeGrants,
          facts: pendingFacts,
          overageStrategy,
          states: tx.readGrantStatesForActiveGrants(activeGrants, input.event.timestamp),
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
    tx: EntitlementWindowStateOps,
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
    tx.writeMeterState({
      meterKey: meter.key,
      createdAt: meterState.createdAt,
      usage: meterState.usage,
      updatedAt: meterState.updatedAt,
    })
  }

  private persistAllowedSingleApplyResult(
    tx: EntitlementWindowStateOps,
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
    tx.writeBatchIdempotencyResults([idempotencyEntry])
    metrics.idempotencyInsertCount = 1
    return idempotencyEntry
  }

  private applyWalletReservationSpendForEvent(params: {
    createdAt: number
    entitlement: EntitlementConfigInput
    input: ApplyInput
    meter: MeterIdentity
    pricedFacts: PricedFact[]
    tx: EntitlementWindowStateOps
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
      requireReservationInvoiceContext(window)
    }

    // Synchronous store write before any post-commit action. On replay the
    // idempotency row short-circuits above, so this only runs on the
    // first-success path.
    tx.updateWalletReservation(spendPlan.walletStateUpdate)
    walletReservationWriteCount++

    if (spendPlan.refillStateUpdate) {
      // pendingRefillAmount is part of the idempotency envelope for
      // flush:{reservationId}:{flushSeq}. Crash recovery may fold in newer
      // unflushed consumption, but the refill leg for an existing seq must stay
      // stable.
      tx.updateWalletReservation(spendPlan.refillStateUpdate)
      walletReservationWriteCount++
      refillTrigger = spendPlan.refillTrigger
    }

    return { refillTrigger, totalCost, walletReservationWriteCount }
  }

  private sumPositivePricedFactUnits(pricedFacts: PricedFact[]): number {
    return pricedFacts.reduce((sum, fact) => sum + Math.max(0, fact.units), 0)
  }

  public async getEnforcementState(
    rawInput: EnforcementStateInput
  ): Promise<EnforcementStateResult> {
    const input = enforcementStateInputSchema.parse(rawInput)
    const timestamp = input.now
    const snapshot = this.readEnforcementStateSnapshot(input, timestamp)
    const { entitlement, states } = snapshot
    const activeGrants = resolveActiveGrants(snapshot.grants, timestamp)

    if (activeGrants.length === 0) {
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
    const window = this.store.readWalletReservation()

    return {
      durableObjectId: this.runtime.instanceId,
      outboxCount: 0,
      nextAlarmAt: this.nextAlarmAt ?? (await this.scheduler.getAlarm()),
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

  public async alarm(): Promise<void> {
    this.nextAlarmAt = null

    return this.instrument("alarm", async () => this.alarmInner())
  }

  private async alarmInner(): Promise<void> {
    const startTime = this.clock.now()
    const now = startTime
    const wideEvent: Record<string, unknown> = {
      operation: "alarm",
    }

    let thrown: unknown

    try {
      wideEvent.idempotency_cleaned = this.runAlarmIdempotencyCleanup(now, wideEvent)

      const inactivityMs = this.timing.inactivityThresholdMs
      const closeHandled = await this.handleAlarmReservationClose({
        inactivityMs,
        now,
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
      // (single-threaded per window, but the apply path's background flush can
      // outlive the request and we don't want the alarm to race it).
      const flushIntervalMs = this.timing.maxFlushIntervalMs
      wideEvent.time_flush_triggered = await this.triggerTimeBasedWalletFlush({
        flushIntervalMs,
        now,
        wideEvent,
      })

      await this.handleAlarmLifecycle({
        flushIntervalMs,
        inactivityMs,
        now,
        wideEvent,
      })
    } catch (error) {
      thrown = error
      throw error
    } finally {
      wideEvent.duration_ms = this.clock.now() - startTime
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
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { flushIntervalMs, inactivityMs, now, wideEvent } = params
    const lifecycleEndAt = this.store.readLifecycleEndAt()
    wideEvent.lifecycle_end_at = lifecycleEndAt

    if (!lifecycleEndAt) {
      // We don't know when this window can be safely collected. Go to sleep.
      // Next apply() will wake us up.
      wideEvent.outcome = "idle"
      return
    }

    // After the latest known grant/reservation window we keep the window alive
    // for the full idempotency TTL before self-destructing.
    const selfDestructAt = lifecycleEndAt + DO_IDEMPOTENCY_TTL_MS

    if (now > selfDestructAt) {
      await this.handleRetentionCleanupAlarm({
        lifecycleEndAt,
        now,
        selfDestructAt,
        wideEvent,
      })
      return
    }

    await this.scheduleNextLifecycleAlarm({
      flushIntervalMs,
      inactivityMs,
      now,
      selfDestructAt,
      wideEvent,
    })
  }

  private async handleAlarmReservationClose(params: {
    inactivityMs: number
    now: number
    wideEvent: Record<string, unknown>
  }): Promise<boolean> {
    const { inactivityMs, now, wideEvent } = params

    // Final-flush detection. Any of three triggers converges on the same
    // flush path: period end, inactivity, or an explicit deletion
    // request. A window without a reservation (or one marked
    // `recoveryRequired`) skips the flush — there's nothing to close out
    // or the last attempt failed terminally and an operator has to look.
    const window = this.store.readWalletReservation()

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
    const pendingFlush = hasPendingWalletFlush(window)
    const isPendingFinalFlush = pendingFlush && window.pendingFlushFinal

    if (pendingFlush && !isPendingFinalFlush) {
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
    await this.scheduler.deleteAlarm()
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
    await this.scheduler.deleteAlarm()
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

    const staleIdempotencyCount = this.store.cleanupStaleIdempotencyKeys(now)
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
    const postFlushWindow = this.store.readWalletReservation()
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
    this.store.updateWalletReservation({
      refillInFlight: true,
      pendingFlushSeq: nextSeq,
      pendingFlushFinal: false,
      pendingFlushAmount: unflushed,
      pendingFlushQuantity: unflushedQuantity,
      pendingRefillAmount: 0,
      spendEwmaAmount: spendVelocity.spendEwmaAmount,
      lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
    })
    await this.requestFlushAndRefill({
      flushSeq: nextSeq,
      flushAmount: unflushed,
      flushQuantity: unflushedQuantity,
      // Time-driven flush is purely about ledger freshness — don't top up
      // allocation here. The window's own refill trigger handles that when the
      // threshold is actually crossed.
      refillAmount: 0,
      effectiveAt: this.clock.now(),
    })

    return true
  }

  private async handleDeletionCleanupAlarm(params: {
    now: number
    originalWindow: OpenWalletReservationSnapshot
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { now, originalWindow, wideEvent } = params
    const latestWindow = this.store.readWalletReservation()
    wideEvent.outbox_remaining = 0
    wideEvent.cleanup_complete = this.isCleanupComplete(latestWindow)
    wideEvent.recovery_required = latestWindow?.recoveryRequired ?? false
    wideEvent.pending_wallet_flush = hasPendingWalletFlush(latestWindow)

    if (this.isCleanupComplete(latestWindow)) {
      wideEvent.self_destruct = true
      wideEvent.outcome = "deleted"
      await this.runtime.destroyWindow()
      return
    }

    if (hasPendingWalletFlush(latestWindow) || (latestWindow?.recoveryRequired ?? false)) {
      wideEvent.self_destruct = false
      wideEvent.operator_action_required = true
      wideEvent.outcome = "operator_required"
      this.logOperatorActionRequired("entitlement deletion cleanup failed", {
        outbox_remaining: 0,
        pending_flush_seq: latestWindow?.pendingFlushSeq ?? null,
        recovery_required: latestWindow?.recoveryRequired ?? false,
        reservation_id: latestWindow ? latestWindow.reservationId : originalWindow.reservationId,
        tinybird_flush_failed: false,
      })
      await this.scheduler.deleteAlarm()
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
    selfDestructAt: number
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { lifecycleEndAt, now, selfDestructAt, wideEvent } = params
    const latestWindow = this.store.readWalletReservation()
    wideEvent.cleanup_complete = this.isCleanupComplete(latestWindow)
    wideEvent.self_destruct_due = true
    wideEvent.pending_wallet_flush = hasPendingWalletFlush(latestWindow)
    wideEvent.recovery_required = latestWindow?.recoveryRequired ?? false

    if (this.isCleanupComplete(latestWindow)) {
      wideEvent.self_destruct = true
      wideEvent.outcome = "deleted"
      await this.runtime.destroyWindow()
      return
    }

    if (hasPendingWalletFlush(latestWindow) || (latestWindow?.recoveryRequired ?? false)) {
      wideEvent.self_destruct = false
      wideEvent.operator_action_required = true
      wideEvent.outcome = "operator_required"
      this.logOperatorActionRequired("entitlement retention cleanup failed", {
        lifecycle_end_at: lifecycleEndAt,
        outbox_remaining: 0,
        pending_flush_seq: latestWindow?.pendingFlushSeq ?? null,
        recovery_required: latestWindow?.recoveryRequired ?? false,
        self_destruct_at: selfDestructAt,
        tinybird_flush_failed: false,
      })
      await this.scheduler.deleteAlarm()
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
    selfDestructAt: number
    wideEvent: Record<string, unknown>
  }): Promise<void> {
    const { flushIntervalMs, inactivityMs, now, selfDestructAt, wideEvent } = params
    // Pick the soonest among: pending wallet recheck, time-based flush
    // deadline, reservation close deadlines, and self-destruct. Re-read the
    // window because the time-flush may have just updated `lastFlushedAt`.
    const finalWindow = this.store.readWalletReservation()
    const candidates: number[] = []
    const pushFutureCandidate = (timestamp: number | null) => {
      if (timestamp !== null && Number.isFinite(timestamp) && timestamp > now) {
        candidates.push(timestamp)
      }
    }

    if (finalWindow?.reservationId && !finalWindow.recoveryRequired) {
      const pendingWalletFlush = hasPendingWalletFlush(finalWindow)
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

  // Mark this window for teardown at the next alarm. We don't
  // delete immediately because there may be a live reservation holding
  // funds in `customer.{cid}.reserved` that must be captured + refunded
  // first. The alarm loop picks up `deletionRequested` on its next wake,
  // closes the reservation when needed, logs the retained state, and leaves any
  // pending cleanup to an operator.
  public async requestDeletion(): Promise<void> {
    this.store.updateWalletReservation({ deletionRequested: true })
    // Pull the alarm in: don't wait for the next natural FLUSH_INTERVAL_MS
    // tick if one isn't already imminent.
    await this.scheduleAlarm(this.clock.now())
  }

  // Flush unflushed consumed usage for invoicing without closing
  // the reservation. The billing endpoint calls this before BILL materializes
  // an invoice, so the ledger reflects captured usage up to this moment.
  // The reservation stays open so new events continue being tracked.
  public async flushReservationForInvoicing(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    return this.instrument("flush_reservation_for_invoicing", async () =>
      this.flushReservationForInvoicingInner(input)
    )
  }

  private async flushReservationForInvoicingInner(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    const startTime = this.clock.now()
    const window = this.store.readWalletReservation()
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

      if (hasPendingWalletFlush(window)) {
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

      this.store.updateWalletReservation({
        refillInFlight: true,
        pendingFlushSeq: flushSeq,
        pendingFlushFinal: false,
        pendingFlushAmount: flushAmount,
        pendingFlushQuantity: flushQuantity,
        pendingRefillAmount: 0,
      })

      await this.requestFlushAndRefill({
        flushSeq,
        flushAmount,
        flushQuantity,
        refillAmount: 0,
        effectiveAt: this.clock.now(),
      })

      const after = this.store.readWalletReservation()
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
      wideEvent.duration_ms = this.clock.now() - startTime
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
  // Grant expiration is deliberately outside the entitlement window.
  private async closeReservation(
    options: CloseReservationOptions
  ): Promise<CloseReservationResult> {
    return this.instrument("close_reservation", async () => this.closeReservationInner(options))
  }

  private async closeReservationInner(
    options: CloseReservationOptions
  ): Promise<CloseReservationResult> {
    const startTime = this.clock.now()
    const window = this.store.readWalletReservation()
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
      this.store.updateWalletReservation({ recoveryRequired: true, refillInFlight: false })
      wideEvent.outcome = "exception"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
      return {
        errorMessage: error instanceof Error ? error.message : String(error),
        ok: false,
        outcome: "exception",
      }
    } finally {
      wideEvent.duration_ms = this.clock.now() - startTime
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

  // Actor fields stamped on every wallet ledger call from this window. The
  // `durable_object`/`durableObjectId` names are part of the ledger metadata
  // contract regardless of the hosting backend.
  private actorMetadata(): {
    requestedBy: "durable_object"
    requestedById: string
    durableObjectId: string
  } {
    const durableObjectId = this.runtime.instanceId
    return { requestedBy: "durable_object", requestedById: durableObjectId, durableObjectId }
  }

  // One capture payload shape for both the final close and the rolling
  // flush+refill: the ledger dedupes on `capture:{reservationId}:{flushSeq}`
  // and invoice projection reads this metadata envelope.
  private buildReservationUsageCapture(params: {
    amount: number
    flushSeq: number
    invoiceContext: ReservationInvoiceContext
    quantity: number
    window: ClosableWalletReservationSnapshot
  }) {
    const { amount, flushSeq, invoiceContext, quantity, window } = params
    const durableObjectId = this.runtime.instanceId
    return {
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      flushSeq,
      amount,
      billingPeriodId: invoiceContext.billingPeriodId,
      kind: "usage" as const,
      statementKey: invoiceContext.statementKey,
      metadata: {
        billing_period_id: invoiceContext.billingPeriodId,
        cycle_end_at: invoiceContext.cycleEndAt,
        cycle_start_at: invoiceContext.cycleStartAt,
        feature_plan_version_item_id: invoiceContext.featurePlanVersionItemId,
        feature_slug: invoiceContext.featureSlug,
        quantity,
        source_id: invoiceContext.sourceId,
        ...this.actorMetadata(),
        durable_object_id: durableObjectId,
        reservation_id: window.reservationId,
        flush_seq: flushSeq,
      },
      sourceId: invoiceContext.sourceId,
    }
  }

  private async closeReservationWithWallet(params: {
    closeReason: ReservationCloseReason
    isRecoveringPendingFinal: boolean
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<CloseReservationResult> {
    const { closeReason, isRecoveringPendingFinal, wideEvent, window } = params
    const walletService = this.wallet.get()
    const invoiceContext = requireReservationInvoiceContext(window)
    const flushIntent = this.persistFinalReservationFlushIntent({
      isRecoveringPendingFinal,
      wideEvent,
      window,
    })

    const capture = await this.captureFinalReservationUsage({
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

    this.store.updateWalletReservation({
      pendingFlushSeq: nextSeq,
      pendingFlushFinal: true,
      pendingFlushAmount: unflushed,
      pendingFlushQuantity: unflushedQuantity,
      pendingRefillAmount: 0,
      refillInFlight: true,
    })

    return { nextSeq, unflushed, unflushedQuantity }
  }

  private async captureFinalReservationUsage(params: {
    invoiceContext: ReservationInvoiceContext
    isRecoveringPendingFinal: boolean
    nextSeq: number
    unflushed: number
    unflushedQuantity: number
    walletService: EntitlementWindowWalletOps
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<ReservationCloseCaptureOutcome> {
    const {
      invoiceContext,
      isRecoveringPendingFinal,
      nextSeq,
      unflushed,
      unflushedQuantity,
      walletService,
      wideEvent,
      window,
    } = params
    const captureResult = await walletService.captureReservationUsage(
      this.buildReservationUsageCapture({
        amount: unflushed,
        flushSeq: nextSeq,
        invoiceContext,
        quantity: unflushedQuantity,
        window,
      })
    )

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
    isRecoveringPendingFinal: boolean
    nextSeq: number
    walletService: EntitlementWindowWalletOps
    wideEvent: Record<string, unknown>
    window: ClosableWalletReservationSnapshot
  }): Promise<ReservationCloseReleaseOutcome> {
    const { closeReason, isRecoveringPendingFinal, nextSeq, walletService, wideEvent, window } =
      params
    const releaseResult = await walletService.releaseReservation({
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      closeReason,
      idempotencyKey: `release:${window.reservationId}:${closeReason}`,
      metadata: this.actorMetadata(),
      sourceId: this.runtime.instanceId,
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
    // Reservation closed. Clear the id so future apply()s on this window
    // skip the wallet check until activateEntitlement opens a new one,
    // and roll the flush bookkeeping forward. We don't zero
    // consumed/allocation: they're historical totals and a reconciler
    // reading the store shouldn't lose them.
    this.store.updateWalletReservation({
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
      lastFlushedAt: this.clock.now(),
    })

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

    if (hasPendingWalletFlush(window) && !isRecoveringPendingFinal) {
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
    this.store.updateWalletReservation({
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
      lastFlushedAt: this.clock.now(),
    })

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
    this.store.updateWalletReservation({ recoveryRequired: true, refillInFlight: false })
    wideEvent.outcome = "wallet_error"
    wideEvent.error_message = error.message
    return {
      errorMessage: error.message,
      ok: false,
      outcome: "wallet_error",
    }
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

  private readEnforcementStateSnapshot(
    input: EnforcementStateInput,
    timestamp: number
  ): EnforcementStateCache {
    const inputSignature = this.enforcementStateInputSignature(input, timestamp)

    if (
      this.enforcementStateCache &&
      this.enforcementStateCache.inputSignature === inputSignature
    ) {
      return this.enforcementStateCache
    }

    const snapshot = this.store.atomically((tx) => {
      const grants = input.grants
      const activeGrants = resolveActiveGrants(grants, timestamp)

      return {
        entitlement: input.entitlement,
        grants,
        inputSignature,
        states: tx.readGrantStatesForActiveGrants(activeGrants, timestamp),
      }
    })

    this.enforcementStateCache = snapshot
    return snapshot
  }

  private enforcementStateInputSignature(input: EnforcementStateInput, timestamp: number): string {
    const bucketKeys = [
      ...new Set(
        input.grants
          .map((grant) => computeGrantPeriodBucket(grant, timestamp)?.bucketKey)
          .filter((key): key is string => typeof key === "string" && key.length > 0)
      ),
    ].sort()

    return JSON.stringify({
      entitlement: input.entitlement,
      grants: input.grants,
      bucketKeys,
    })
  }

  public invalidateEnforcementStateCache(): void {
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
    tx: EntitlementWindowStateOps,
    params: {
      activeGrants: ActiveGrantInput[]
      entitlement: EntitlementConfigInput
      eventTimestamp: number
      facts: Fact[]
    }
  ): { periodWriteCount: number; pricedFacts: PricedFact[]; touchedStateCount: number } {
    const grantStates = params.facts.some((fact) => fact.delta > 0)
      ? tx.readGrantStatesForActiveGrants(params.activeGrants, params.eventTimestamp)
      : []
    const { pricedFacts, touchedStates } = this.priceFactsFromGrantStates({
      ...params,
      grantStates,
    })

    const periodWriteCount = tx.writeGrantConsumptions(touchedStates.values())

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

        replaceGrantConsumptionState(params.grantStates, allocation.nextState)
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

  private isCleanupComplete(window: WalletReservationSnapshot): boolean {
    return !window?.reservationId && !window?.recoveryRequired && !hasPendingWalletFlush(window)
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

    requireReservationInvoiceContext(readiness.window)
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

    requireReservationInvoiceContext(readiness.window)
    // Persist minimal flush/refill intent without full refill decision state.
    // The batch retry path does not recompute spend velocity or target reservation
    // since the headroom helpers already sized the refill amount.
    this.store.updateWalletReservation({
      refillInFlight: true,
      pendingFlushSeq: trigger.flushSeq,
      pendingFlushFinal: false,
      pendingFlushAmount: trigger.flushAmount,
      pendingFlushQuantity: trigger.flushQuantity,
      pendingRefillAmount: trigger.refillAmount,
    })
    await this.requestFlushAndRefill(trigger)

    return { kind: "refilled", trigger }
  }

  private resolveReservationGrowthReadiness(
    params: EntitlementWindowReservationUnderfundedError["params"]
  ): ReservationGrowthReadiness {
    const window = this.store.readWalletReservation()
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
            nowMs: this.clock.now(),
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
    this.store.updateWalletReservation({
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
  }

  // Slice 7.5. Captures consumed reserved funds, then extends reservation
  // runway, and folds the deltas back into the window's local state.
  //
  // `flushSeq` is the idempotency seal: the ledger dedupes on
  // `capture:{reservationId}:{flushSeq}` / `extend:{reservationId}:{flushSeq}`,
  // so replays after a crash produce the same outcome. On error we only clear `refillInFlight` — the
  // `pendingFlushSeq` stays set so crash recovery (or the next apply()
  // that observes `pendingFlushSeq > flushSeq`) can retry with the same
  // seq and the same persisted amount. Newer local usage waits for the next
  // flush seq instead of changing the payload behind the same idempotency key.
  private async requestFlushAndRefill(trigger: RefillTrigger): Promise<void> {
    return this.instrument("flush_refill", async () => this.requestFlushAndRefillInner(trigger), {
      flush_seq: trigger.flushSeq,
      flush_amount: trigger.flushAmount,
      flush_quantity: trigger.flushQuantity,
      reservation_refill_requested_amount: trigger.refillAmount,
    })
  }

  private async requestFlushAndRefillInner(trigger: RefillTrigger): Promise<void> {
    const startTime = this.clock.now()
    const window = this.store.readWalletReservation()
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
      this.store.updateWalletReservation({ refillInFlight: false })
      wideEvent.outcome = "exception"
      wideEvent.error_type = error instanceof Error ? error.name : "unknown"
      wideEvent.error_message = error instanceof Error ? error.message : String(error)
    } finally {
      wideEvent.duration_ms = this.clock.now() - startTime
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
      this.store.updateWalletReservation({ refillInFlight: false })
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
    this.store.updateWalletReservation({
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
      lastFlushedAt: this.clock.now(),
    })

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
    const invoiceContext = requireReservationInvoiceContext(window)
    const captureResult = await this.wallet.get().captureReservationUsage(
      this.buildReservationUsageCapture({
        amount: trigger.flushAmount,
        flushSeq: trigger.flushSeq,
        invoiceContext,
        quantity: trigger.flushQuantity,
        window,
      })
    )

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
    const extendResult = await this.wallet.get().extendReservation({
      projectId: window.projectId,
      customerId: window.customerId,
      currency: window.currency as Currency,
      reservationId: window.reservationId,
      flushSeq: trigger.flushSeq,
      requestedAmount: trigger.refillAmount,
      statementKey: `${window.reservationId}:${window.reservationEndAt ?? 0}`,
      effectiveAt: new Date(trigger.effectiveAt),
      metadata: this.actorMetadata(),
      sourceId: this.runtime.instanceId,
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
    this.store.updateWalletReservation({ refillInFlight: false })
    wideEvent.outcome = "wallet_error"
    wideEvent.error_message = error.message
  }

  private persistDeniedApplyResult(
    params: {
      closeReason?: ReservationCloseReason
      createdAt: number
      deniedReason?: DeniedReason
      idempotencyKey: string
      message?: string
    },
    // Defaults to auto-commit; the external-reservation apply path passes its
    // open transaction so the denial seal joins that atomic boundary.
    ops: EntitlementWindowStateOps = this.store
  ): ApplyResult {
    const deniedResult: ApplyResult = { allowed: false }
    if (params.deniedReason) {
      deniedResult.deniedReason = params.deniedReason
    }
    if (params.message) {
      deniedResult.message = params.message
    }

    this.persistBatchIdempotencyResult(
      {
        eventId: params.idempotencyKey,
        createdAt: params.createdAt,
        allowed: false,
        deniedReason: deniedResult.deniedReason ?? null,
        denyMessage: deniedResult.message ?? null,
        meterFacts: [],
      },
      ops
    )

    if (params.closeReason) {
      this.runtime.waitUntil(this.closeReservation({ closeReason: params.closeReason }))
    }

    return deniedResult
  }

  private persistBatchIdempotencyResult(
    entry: BatchIdempotencyEntry,
    ops: EntitlementWindowStateOps = this.store
  ): void {
    ops.writeBatchIdempotencyResults([entry])
    this.store.recordBatchIdempotencyResults([entry])
    this.schedulePostCommitAlarm()
  }

  private async bootstrapReservationSingleFlight(
    input: ApplyInput,
    activeGrants: ActiveGrantInput[],
    meter: MeterIdentity
  ): Promise<ApplyResult | null> {
    const existing = this.reservationBootstrapPromise
    if (existing) {
      const result = await existing
      const window = this.store.readWalletReservation()
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
  // subsequent events on this window short-circuit through the in-tx reservation
  // policy check. The window may attempt one synchronous grow before returning
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
    const result = await this.wallet.get().createReservation({
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
        ...this.actorMetadata(),
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
      // allocation=0 so future events on this window go through the standard
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
      sampledAtMs: this.clock.now(),
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
    this.store.ensureMeterState({
      meterKey: meter.key,
      createdAt: this.clock.now(),
    })
    this.store.ensureWalletReservation({
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

    this.store.updateWalletReservation(reservationUpdate)
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
    ops: EntitlementWindowStateOps,
    input: ApplyInput,
    window: WalletReservationSnapshot
  ): WalletReservationSnapshot {
    if (!window?.reservationId || !isReservationInvoiceContextMissing(window)) {
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

    ops.updateWalletReservation(patch)

    return {
      ...window,
      ...patch,
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
    const engine = new AsyncMeterAggregationEngine([params.meter.config], adapter, this.clock.now())
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

    const row = this.store.readMeterStateDraft(meter.key, this.clock.now())

    const previousValue = row.usage
    const previousUpdatedAt = row.updatedAt === null ? Number.NEGATIVE_INFINITY : row.updatedAt

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
        const nextValue = row.exists ? Math.max(previousValue, numericValue) : numericValue
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
      states: this.store.readGrantStatesForActiveGrants(params.activeGrants, params.eventTimestamp),
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

  private shouldRunIdempotencyCleanup(now: number): boolean {
    return (
      this.lastIdempotencyCleanupAt === null ||
      now - this.lastIdempotencyCleanupAt >= IDEMPOTENCY_CLEANUP_INTERVAL_MS
    )
  }

  private async scheduleAlarm(target: number): Promise<void> {
    const now = this.clock.now()
    if (this.nextAlarmAt !== null && this.nextAlarmAt > now && this.nextAlarmAt <= target) {
      return
    }

    const existing = await this.scheduler.getAlarm()
    if (existing !== null && existing > now && existing <= target) {
      this.nextAlarmAt = existing
      return
    }
    await this.scheduler.setAlarm(target)
    this.nextAlarmAt = target
  }

  private schedulePostCommitAlarm(): void {
    this.runtime.waitUntil(this.scheduleAlarm(this.clock.now() + FLUSH_INTERVAL_MS))
  }
}
