import type { Currency } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import {
  type GrantConsumptionState,
  computeGrantPeriodBucket,
  computeMaxMarginalPriceMinor,
} from "@unprice/services/entitlements"
import type { CreateReservationOutput, ReservationCloseReason } from "@unprice/services/wallet"
import {
  type InitialReservationDecision,
  type ReservationPolicy,
  computeInitialReservation,
  computeRefillDecision,
  computeSyncGrowRefillAmount,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import { addLedgerAmountDisplayFields, readLogCurrency } from "./apply-telemetry"
import {
  computeBatchReservationHeadroom,
  computeBatchReservationRefillAmount,
} from "./batch-apply-helpers"
import type {
  ActiveGrantInput,
  ApplyInput,
  ApplyResult,
  CloseReservationOptions,
  CloseReservationResult,
  EntitlementConfigInput,
  EntitlementWindowBatchReservationUnderfundedError,
  EntitlementWindowReservationUnderfundedError,
  FlushReservationForInvoicingInput,
  FlushReservationForInvoicingResult,
  MeterIdentity,
  RefillTrigger,
  ReservationGrowthResult,
  WalletReservationSnapshot,
} from "./contracts"
import type { MeterStateDraft } from "./meter-state-adapter"
import type {
  EntitlementWindowClock,
  EntitlementWindowRuntime,
  EntitlementWindowStateOps,
  EntitlementWindowStateStore,
  EntitlementWindowWalletOps,
  EntitlementWindowWalletProvider,
} from "./ports"
import { firstGrantByDrainOrder, projectEventCostMinor } from "./pricing"
import {
  type ReservationInvoiceContext,
  hasPendingWalletFlush,
  isReservationInvoiceContextMissing,
  requireReservationInvoiceContext,
} from "./wallet-reservation-flow"

type BatchReservationGrowthResult = ReservationGrowthResult | { kind: "max_outstanding_reached" }

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

type FlushAndRefill = (trigger: RefillTrigger) => Promise<void>

type ReservationLifecycleDeps = {
  clock: EntitlementWindowClock
  logger: Logger
  policy: ReservationPolicy
  runtime: EntitlementWindowRuntime
  store: EntitlementWindowStateStore
  wallet: EntitlementWindowWalletProvider
}

export class ReservationLifecycle {
  private readonly clock: EntitlementWindowClock
  private readonly logger: Logger
  private readonly policy: ReservationPolicy
  private readonly runtime: EntitlementWindowRuntime
  private readonly store: EntitlementWindowStateStore
  private readonly wallet: EntitlementWindowWalletProvider

  // In-memory single-flight for lazy reservation bootstrap. It only dedupes
  // external wallet I/O while this window instance is alive; the reservation
  // row remains the durable source of truth.
  private reservationBootstrapPromise: Promise<ApplyResult | null> | null = null

  constructor(deps: ReservationLifecycleDeps) {
    this.clock = deps.clock
    this.logger = deps.logger
    this.policy = deps.policy
    this.runtime = deps.runtime
    this.store = deps.store
    this.wallet = deps.wallet
  }

  public async flushReservationForInvoicing(
    input: FlushReservationForInvoicingInput,
    flushAndRefill: FlushAndRefill
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

      await flushAndRefill({
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

  public async closeReservation(options: CloseReservationOptions): Promise<CloseReservationResult> {
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

  public async growReservationForCurrentEvent(
    params: EntitlementWindowReservationUnderfundedError["params"],
    flushAndRefill: FlushAndRefill
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
    await flushAndRefill(plan.trigger)

    return { kind: "refilled", trigger: plan.trigger }
  }

  public async growReservationForBatchHeadroom(
    params: EntitlementWindowBatchReservationUnderfundedError["params"],
    flushAndRefill: FlushAndRefill
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
      maxOutstandingAmount: this.policy.maxOutstandingAmount,
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
    await flushAndRefill(trigger)

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
            policy: this.policy,
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
      policy: this.policy,
    })
    const refillAmount = computeSyncGrowRefillAmount({
      remainingAmount: currentRemaining,
      currentEventCostAmount,
      targetReservationAmount: refillDecision.targetReservationAmount,
      maxOutstandingAmount: this.policy.maxOutstandingAmount,
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
  public async requestFlushAndRefill(trigger: RefillTrigger): Promise<void> {
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

  public async bootstrapReservationSingleFlight(
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

  public async bootstrapReservationForProjectedCost(params: {
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
    const policy = this.policy
    const sizing = computeInitialReservation({
      pricePerEventAmount: pricePerEvent,
      currentEventCostAmount: projectedCost,
      policy,
    })
    if (sizing.requestedAmount <= 0) return null

    const reservationGrant = firstGrantByDrainOrder(activeGrants)
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

  public refreshWalletReservationInvoiceContextIfMissing(
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
    activeGrants: readonly ActiveGrantInput[],
    meter: MeterIdentity
  ): number {
    const now = this.clock.now()
    const grantStates = this.store.readGrantStatesForActiveGrants(
      [...activeGrants],
      input.event.timestamp
    )
    const meterState = this.store.readMeterStateDraft(meter.key, now)

    return projectEventCostMinor({
      activeGrants,
      entitlement: input.entitlement,
      event: input.event,
      eventTimestamp: input.event.timestamp,
      grantStates,
      meter,
      meterState,
      timestampValidationNow: null,
    })
  }

  public computeProjectedBatchEventCostMinor(params: {
    activeGrants: readonly ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    event: ApplyInput["event"]
    eventTimestamp: number
    grantStates: readonly GrantConsumptionState[]
    meter: MeterIdentity
    meterState: Readonly<MeterStateDraft>
  }): number {
    return projectEventCostMinor({
      ...params,
      timestampValidationNow: this.clock.now(),
    })
  }
}
