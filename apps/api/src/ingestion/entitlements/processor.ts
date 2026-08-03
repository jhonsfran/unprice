import type { OverageStrategy } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { LEDGER_SCALE } from "@unprice/money"
import {
  AsyncMeterAggregationEngine,
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type Fact,
  type GrantConsumptionState,
  computeGrantPeriodBucket,
  computeUsagePriceDeltaMinor,
  resolveActiveGrants,
  resolveAvailableGrantUnits,
  resolveConsumedGrantUnits,
} from "@unprice/services/entitlements"
import type { ReservationCloseReason } from "@unprice/services/wallet"
import { DEFAULT_RESERVATION_POLICY } from "@unprice/services/wallet/reservation-sizing"
import { AlarmLifecycle } from "./alarm-lifecycle"
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
  createAllowedBatchOutcome,
  createCachedBatchResult,
  createDeniedBatchOutcome,
  planWalletReservationSpend,
} from "./batch-apply-helpers"
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
  type WalletReservationSnapshot,
  applyBatchInputSchema,
  applyInputSchema,
  createApplyBatchMetrics,
  enforcementStateInputSchema,
} from "./contracts"
import { selectGrantStatesForActiveGrants } from "./entitlement-window-store"
import { extractCurrencyCodeFromFeatureConfig, resolveMeterIdentity } from "./meter-helpers"
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
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
} from "./ports"
import {
  buildMeterFactPayload,
  findGrantLimitExceededFact,
  priceFactsFromGrantStates,
  resolveLateClosedPeriod,
  resolveTotalGrantUnits,
} from "./pricing"
import { resolveSharedQuotaWindow } from "./quota-window"
import { ReservationLifecycle } from "./reservation-lifecycle"
import { unique } from "./utils"
import { requireReservationInvoiceContext } from "./wallet-reservation-flow"

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

type OpenWalletReservationSnapshot = NonNullable<WalletReservationSnapshot> & {
  reservationId: string
}

/**
 * Backend-neutral entitlement window orchestrator. Owns apply/applyBatch and
 * enforcement reads, while delegating reservation and alarm lifecycle work to
 * focused collaborators.
 * Talks to the host platform exclusively through the ports in ./ports.ts —
 * the Cloudflare Durable Object adapter (EntitlementWindowDO) is one wiring;
 * a Redis-backed store/scheduler/runtime would be another.
 */
export class EntitlementWindowProcessor {
  private readonly alarms: AlarmLifecycle
  private readonly clock: EntitlementWindowClock
  private readonly instrument: EntitlementWindowInstrumentation
  private readonly logger: Logger
  private readonly reservations: ReservationLifecycle
  private readonly runtime: EntitlementWindowRuntime
  private readonly store: EntitlementWindowStateStore

  private enforcementStateCache: EnforcementStateCache | null = null

  constructor(deps: EntitlementWindowProcessorDeps) {
    this.clock = deps.clock
    this.instrument = deps.instrument
    this.logger = deps.logger
    this.reservations = new ReservationLifecycle({
      clock: deps.clock,
      logger: deps.logger,
      policy: DEFAULT_RESERVATION_POLICY,
      runtime: deps.runtime,
      store: deps.store,
      wallet: deps.wallet,
    })
    this.alarms = new AlarmLifecycle({
      clock: deps.clock,
      closeReservation: (options) => this.closeReservation(options),
      logger: deps.logger,
      policy: DEFAULT_RESERVATION_POLICY,
      requestFlushAndRefill: (trigger) => this.requestFlushAndRefill(trigger),
      runtime: deps.runtime,
      scheduler: deps.scheduler,
      store: deps.store,
      timing: deps.timing,
    })
    this.runtime = deps.runtime
    this.store = deps.store
  }

  /**
   * Run once per window wake, after the store is migrated/hydrated and before
   * the first command. Restores the alarm watermark and replays any wallet
   * flush that was interrupted by an eviction/crash.
   */
  public async initialize(): Promise<void> {
    await this.alarms.initialize()

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
            const denial = await this.reservations.bootstrapReservationForProjectedCost({
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
              const growth = await this.reservations.growReservationForBatchHeadroom(
                underfundedError.params,
                (trigger) => this.requestFlushAndRefill(trigger)
              )
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

    const lateClosedPeriod = resolveLateClosedPeriod({
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
      state.wallet = this.reservations.refreshWalletReservationInvoiceContextIfMissing(
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

    const { grantStates, pricedFacts, touchedStates } = priceFactsFromGrantStates({
      activeGrants,
      entitlement: setup.entitlement,
      eventTimestamp: event.timestamp,
      facts,
      grantStates: state.grantStates,
    })
    state.metrics.priced_fact_count += pricedFacts.length
    state.metrics.grant_allocation_count += touchedStates.size
    state.grantStates = [...grantStates]

    for (const [bucketKey, grantState] of touchedStates.entries()) {
      state.touchedGrantStates.set(bucketKey, grantState)
    }

    return [...pricedFacts]
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
      buildMeterFactPayload({
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

    const projectedCost = this.reservations.computeProjectedBatchEventCostMinor({
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

    const denial = await this.reservations.bootstrapReservationForProjectedCost({
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

    const projectedCost = this.reservations.computeProjectedBatchEventCostMinor({
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

        const exceeded = findGrantLimitExceededFact({
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
        policy: DEFAULT_RESERVATION_POLICY,
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
    this.alarms.schedulePostCommitAlarm()

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
          buildMeterFactPayload({
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
        this.alarms.schedulePostCommitAlarm()

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
    const lateClosedPeriod = resolveLateClosedPeriod({
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
      denial = await this.reservations.bootstrapReservationSingleFlight(input, activeGrants, meter)
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
          this.alarms.schedulePostCommitAlarm()
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

        const growth = await this.reservations.growReservationForCurrentEvent(
          handledError.params,
          (trigger) => this.requestFlushAndRefill(trigger)
        )

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
        buildMeterFactPayload({
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

    const grantStates = facts.some((fact) => fact.delta > 0)
      ? tx.readGrantStatesForActiveGrants(activeGrants, input.event.timestamp)
      : []
    const priced = priceFactsFromGrantStates({
      activeGrants,
      entitlement,
      eventTimestamp: input.event.timestamp,
      facts,
      grantStates,
    })
    const periodWriteCount = tx.writeGrantConsumptions(priced.touchedStates.values())
    metrics.pricedFactCount = priced.pricedFacts.length
    metrics.grantAllocationCount = priced.touchedStates.size
    metrics.grantWindowWriteCount = periodWriteCount

    return [...priced.pricedFacts]
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
    const window = this.reservations.refreshWalletReservationInvoiceContextIfMissing(
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

        const exceeded = findGrantLimitExceededFact({
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
      policy: DEFAULT_RESERVATION_POLICY,
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
        quotaWindow: null,
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
    const limit = resolveTotalGrantUnits(activeGrants)
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
      quotaWindow: resolveSharedQuotaWindow(activeGrants, timestamp),
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
    const alarmStatus = await this.alarms.getStatus()

    return {
      durableObjectId: this.runtime.instanceId,
      outboxCount: 0,
      nextAlarmAt: alarmStatus.nextAlarmAt,
      lastIdempotencyCleanupAt: alarmStatus.lastIdempotencyCleanupAt,
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
    return this.instrument("alarm", async () => this.alarms.alarm())
  }

  public async requestDeletion(): Promise<void> {
    return this.alarms.requestDeletion()
  }

  public async flushReservationForInvoicing(
    input: FlushReservationForInvoicingInput
  ): Promise<FlushReservationForInvoicingResult> {
    return this.instrument("flush_reservation_for_invoicing", async () =>
      this.reservations.flushReservationForInvoicing(input, (trigger) =>
        this.requestFlushAndRefill(trigger)
      )
    )
  }

  private async closeReservation(
    options: CloseReservationOptions
  ): Promise<CloseReservationResult> {
    return this.instrument("close_reservation", async () =>
      this.reservations.closeReservation(options)
    )
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

  private async requestFlushAndRefill(trigger: RefillTrigger): Promise<void> {
    return this.instrument(
      "flush_refill",
      async () => this.reservations.requestFlushAndRefill(trigger),
      {
        flush_seq: trigger.flushSeq,
        flush_amount: trigger.flushAmount,
        flush_quantity: trigger.flushQuantity,
        reservation_refill_requested_amount: trigger.refillAmount,
      }
    )
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
    this.alarms.schedulePostCommitAlarm()
  }
}
