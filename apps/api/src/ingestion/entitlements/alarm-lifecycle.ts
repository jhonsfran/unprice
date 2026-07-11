import type { Logger } from "@unprice/logs"
import { DO_IDEMPOTENCY_TTL_MS } from "@unprice/services/entitlements"
import type { ReservationCloseReason } from "@unprice/services/wallet"
import {
  type ReservationPolicy,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import { FLUSH_INTERVAL_MS, IDEMPOTENCY_CLEANUP_INTERVAL_MS } from "./constants"
import type {
  CloseReservationOptions,
  CloseReservationResult,
  RefillTrigger,
  WalletReservationSnapshot,
} from "./contracts"
import type {
  EntitlementWindowClock,
  EntitlementWindowRuntime,
  EntitlementWindowScheduler,
  EntitlementWindowStateStore,
  EntitlementWindowTimingConfig,
} from "./ports"
import { hasPendingWalletFlush } from "./wallet-reservation-flow"

type OpenWalletReservationSnapshot = NonNullable<WalletReservationSnapshot> & {
  reservationId: string
}

type AlarmReservationCloseTrigger = {
  closeReason: ReservationCloseReason
  isDeletionPending: boolean
}

type AlarmLifecycleDeps = {
  clock: EntitlementWindowClock
  closeReservation: (options: CloseReservationOptions) => Promise<CloseReservationResult>
  logger: Logger
  policy: ReservationPolicy
  requestFlushAndRefill: (trigger: RefillTrigger) => Promise<void>
  runtime: EntitlementWindowRuntime
  scheduler: EntitlementWindowScheduler
  store: EntitlementWindowStateStore
  timing: EntitlementWindowTimingConfig
}

export class AlarmLifecycle {
  private readonly clock: EntitlementWindowClock
  private readonly closeReservation: AlarmLifecycleDeps["closeReservation"]
  private readonly logger: Logger
  private readonly policy: ReservationPolicy
  private readonly requestFlushAndRefill: AlarmLifecycleDeps["requestFlushAndRefill"]
  private readonly runtime: EntitlementWindowRuntime
  private readonly scheduler: EntitlementWindowScheduler
  private readonly store: EntitlementWindowStateStore
  private readonly timing: EntitlementWindowTimingConfig

  private lastIdempotencyCleanupAt: number | null = null
  private nextAlarmAt: number | null = null

  constructor(deps: AlarmLifecycleDeps) {
    this.clock = deps.clock
    this.closeReservation = deps.closeReservation
    this.logger = deps.logger
    this.policy = deps.policy
    this.requestFlushAndRefill = deps.requestFlushAndRefill
    this.runtime = deps.runtime
    this.scheduler = deps.scheduler
    this.store = deps.store
    this.timing = deps.timing
  }

  public async initialize(): Promise<void> {
    this.nextAlarmAt = await this.scheduler.getAlarm()
  }

  public async alarm(): Promise<void> {
    this.nextAlarmAt = null
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
      policy: this.policy,
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

  public schedulePostCommitAlarm(): void {
    this.runtime.waitUntil(this.scheduleAlarm(this.clock.now() + FLUSH_INTERVAL_MS))
  }

  public async getStatus(): Promise<{
    lastIdempotencyCleanupAt: number | null
    nextAlarmAt: number | null
  }> {
    return {
      lastIdempotencyCleanupAt: this.lastIdempotencyCleanupAt,
      nextAlarmAt: this.nextAlarmAt ?? (await this.scheduler.getAlarm()),
    }
  }
}
