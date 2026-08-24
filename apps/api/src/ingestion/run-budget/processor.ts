import { resolveRunReservationExpiration } from "@unprice/services/budget-runs"
import { findBillingPeriodAt } from "@unprice/services/ingestion"
import { CAPTURE_ABANDONED_STATUS, MAX_CAPTURE_ATTEMPTS, captureBackoffMs } from "./capture-policy"
import { captureIntentFlushSeq } from "./capture-range"
import {
  type ApplyRunSyncEventInput,
  type EndRunInput,
  type FlushRunBudgetCapturesForInvoicingInput,
  type FlushRunBudgetCapturesForInvoicingResult,
  type GetRunStatusInput,
  type RunBudgetDecision,
  type RunBudgetSummary,
  type SettleRunInput,
  type StartRunInput,
  applyRunSyncEventInputSchema,
  endRunInputSchema,
  flushRunBudgetCapturesForInvoicingInputSchema,
  getRunStatusInputSchema,
  settleRunInputSchema,
  startRunInputSchema,
} from "./contracts"
import type {
  RunBudgetMeterFact,
  RunBudgetProcessorDeps,
  RunCaptureIntent,
  RunSpendBucketDelta,
  RunState,
} from "./ports"

class RunCapturesPendingError extends Error {
  constructor(runId: string) {
    super(`Unresolved capture intents remain for run ${runId}`)
    this.name = "RunCapturesPendingError"
  }
}

type ResolvedStartRunInput = Omit<StartRunInput, "expiresAt"> & { expiresAt: number }

export class RunBudgetProcessor {
  constructor(private readonly deps: RunBudgetProcessorDeps) {}

  async startRun(rawInput: StartRunInput): Promise<RunBudgetSummary> {
    const parsedInput = startRunInputSchema.parse(rawInput)
    const expiration = resolveRunReservationExpiration({
      expiresAt: parsedInput.expiresAt,
      now: parsedInput.now,
    })
    if (!expiration.valid) {
      throw new Error("Run expiration cannot exceed 24 hours")
    }
    const input: ResolvedStartRunInput = { ...parsedInput, expiresAt: expiration.expiresAt }

    // Idempotent: if run already exists, return current state
    const existing = await this.deps.store.loadRun(input.runId)
    if (existing) {
      if (existing.status === "running" && existing.expiresAt) {
        await this.scheduleAlarmAt(existing.expiresAt)
      }
      return this.toSummary(existing)
    }

    // Create wallet reservation for the run budget
    const walletResult = await this.createRunReservation(input)

    if (!walletResult.success) {
      // Wallet has insufficient funds -- return a summary with failed status
      // instead of throwing, so the caller gets a proper business error.
      return {
        runId: input.runId,
        status: "failed" as RunBudgetSummary["status"],
        endedAt: input.now,
        budgetAmount: input.budgetAmount,
        consumedAmount: 0,
        remainingAmount: 0,
        walletReservationId: null,
        walletError: walletResult.reason,
      }
    }

    // Persist run state
    await this.deps.store.createRun({
      runId: input.runId,
      projectId: input.projectId,
      customerId: input.customerId,
      workloadType: input.workloadType ?? null,
      workloadId: input.workloadId ?? null,
      parentRunId: input.parentRunId ?? null,
      reservationId: walletResult.reservationId,
      status: "running",
      currency: input.currency,
      budgetAmount: input.budgetAmount,
      reservedAmount: walletResult.allocationAmount,
      consumedAmount: 0,
      flushedAmount: 0,
      lastCaptureSeq: 0,
      startedAt: input.now,
      endedAt: null,
      expiresAt: input.expiresAt,
      lastEventAt: null,
      traceId: input.traceId ?? null,
      metadataJson: JSON.stringify(input.metadata),
      reconciliationNeeded: false,
    })

    await this.scheduleAlarmAt(input.expiresAt)

    const run = await this.deps.store.loadRun(input.runId)
    if (!run) throw new Error("Run state missing after startRun insert")
    return this.toSummary(run)
  }

  async applySyncEvent(rawInput: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    const input = applyRunSyncEventInputSchema.parse(rawInput)
    return this.applySyncEventLocked(input, { allowUnfunded: false, enforceLimit: true })
  }

  async settleRun(rawInput: SettleRunInput): Promise<RunBudgetDecision> {
    const input = settleRunInputSchema.parse(rawInput)
    return this.applySyncEventLocked(input, { allowUnfunded: true, enforceLimit: false })
  }

  private async applySyncEventLocked(
    input: ApplyRunSyncEventInput,
    options: { allowUnfunded: boolean; enforceLimit: boolean }
  ): Promise<RunBudgetDecision> {
    // Check idempotency
    const cached = await this.deps.store.loadIdempotency(input.idempotencyKey)
    if (cached) {
      const decision = JSON.parse(cached.decisionJson) as RunBudgetDecision
      const run = await this.deps.store.loadRun(input.runId)
      let replay = { ...decision, meterFacts: decision.meterFacts ?? [] }

      // Rolling-deploy repair: an older DO may have cached a terminal decision
      // before summaries carried endedAt. Rehydrate only the missing timestamp
      // from this DO's authoritative run state; every cached decision field
      // remains unchanged.
      if (decision.budget.status !== "running" && decision.budget.endedAt == null) {
        if (
          run?.runId === decision.budget.runId &&
          run.status !== "running" &&
          run.endedAt != null
        ) {
          replay = {
            ...decision,
            budget: { ...decision.budget, endedAt: run.endedAt },
            meterFacts: decision.meterFacts ?? [],
          }
        }
      }

      await this.repairAcceptedReplayAlarm(run, replay)
      return replay
    }

    // Load run state
    const run = await this.deps.store.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")
    if (run.status !== "running") {
      const decision: RunBudgetDecision = {
        allowed: false,
        state: "rejected",
        rejectionReason: "RUN_BUDGET_EXCEEDED",
        message: `Run is ${run.status}, not running`,
        budget: this.toSummary(run),
        meterFacts: [],
      }
      await this.deps.store.persistIdempotency(
        input.idempotencyKey,
        input.runId,
        decision,
        0,
        [],
        this.deps.clock.now()
      )
      return decision
    }
    if (run.expiresAt !== null && run.expiresAt <= input.now) {
      const decision = await this.rejectExpiredRun(input, run)
      await this.deps.store.persistIdempotency(
        input.idempotencyKey,
        input.runId,
        decision,
        0,
        [],
        this.deps.clock.now()
      )
      return decision
    }

    // Compute remaining budget
    const remainingAmount = Math.max(0, run.budgetAmount - run.consumedAmount)

    const missingBillingPeriodDecision = this.rejectMissingBillingPeriodContext(input, run)
    if (missingBillingPeriodDecision) {
      await this.deps.store.persistIdempotency(
        input.idempotencyKey,
        input.runId,
        missingBillingPeriodDecision,
        0,
        [],
        this.deps.clock.now()
      )
      return missingBillingPeriodDecision
    }

    // Delegate pricing to EntitlementWindowDO with external reservation mode
    const entitlementResult = await this.callEntitlementWindow(
      input,
      options.allowUnfunded ? Number.MAX_SAFE_INTEGER : remainingAmount,
      options.enforceLimit
    )

    if (!entitlementResult.allowed) {
      // Pricing/limit denied or run budget exceeded
      const decision: RunBudgetDecision = {
        allowed: false,
        state: "rejected",
        rejectionReason: entitlementResult.deniedReason as RunBudgetDecision["rejectionReason"],
        message: entitlementResult.message,
        budget: this.toSummary(run),
        meterFacts: [],
      }
      await this.deps.store.persistIdempotency(
        input.idempotencyKey,
        input.runId,
        decision,
        0,
        [],
        this.deps.clock.now()
      )
      return decision
    }

    // Derive priced cost from meter facts
    const meterFacts = this.withRunContext(run, entitlementResult.meterFacts)
    const pricedAmount = this.sumPricedAmount(meterFacts)
    const fundedAmount = Math.min(pricedAmount, remainingAmount)
    const unfundedAmount = pricedAmount - fundedAmount
    const bucketDeltas = this.allocateFundedBucketDeltas(
      this.deriveBucketDeltas(run, input.entitlement, meterFacts),
      fundedAmount
    )

    const updatedRun = this.projectRunSpend(run, pricedAmount, input.now)
    const decision: RunBudgetDecision = {
      allowed: true,
      state: "processed",
      budget: this.toSummary(updatedRun),
      meterFacts,
      fundingStatus:
        fundedAmount === 0 && unfundedAmount > 0
          ? "unfunded"
          : unfundedAmount > 0
            ? "partially_funded"
            : "fully_funded",
      fundedAmount,
      unfundedAmount,
    }

    await this.commitSpendAndIdempotency(
      run,
      updatedRun,
      input.idempotencyKey,
      decision,
      pricedAmount,
      bucketDeltas
    )

    // Only funded spend produces capture buckets. Unfunded usage is still recorded,
    // but there is nothing that the wallet can capture for that amount.
    if (bucketDeltas.length > 0) {
      await this.scheduleAlarm()
    }

    return decision
  }

  async endRun(rawInput: EndRunInput): Promise<RunBudgetSummary> {
    const input = endRunInputSchema.parse(rawInput)

    const { summary } = await this.closeRunInStorage(input)
    return summary
  }

  async getRunStatus(rawInput: GetRunStatusInput): Promise<RunBudgetSummary> {
    const input = getRunStatusInputSchema.parse(rawInput)
    const run = await this.deps.store.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")
    return this.toSummary(run)
  }

  /** Flush pending captures to wallet. Called by alarm and endRun. */
  async flushCaptures(): Promise<void> {
    await this.flushCaptureBuckets()
  }

  /** Flush pending captures for one invoice statement before invoice materialization. */
  async flushCapturesForInvoicing(
    rawInput: FlushRunBudgetCapturesForInvoicingInput
  ): Promise<FlushRunBudgetCapturesForInvoicingResult> {
    const input = flushRunBudgetCapturesForInvoicingInputSchema.parse(rawInput)
    const result = await this.flushCaptureBuckets({
      failOnCaptureError: true,
      statementKey: input.statementKey,
      billingPeriodIds: input.billingPeriodIds,
    })

    return {
      ok: true,
      ...result,
    }
  }

  private async flushCaptureBuckets(filter?: {
    billingPeriodIds?: string[]
    failOnCaptureError?: boolean
    statementKey?: string
  }): Promise<{ flushed: number; skipped: number }> {
    const billingPeriodIds = new Set(filter?.billingPeriodIds ?? [])

    const unfilteredBuckets = await this.deps.store.listUnflushedBuckets()
    const buckets = unfilteredBuckets.filter((bucket) => {
      if (!filter?.statementKey && billingPeriodIds.size === 0) return true
      return (
        bucket.statementKey === filter?.statementKey ||
        (bucket.billingPeriodId.length > 0 && billingPeriodIds.has(bucket.billingPeriodId))
      )
    })

    let flushed = 0
    let skipped = 0
    for (const bucket of buckets) {
      const run = await this.deps.store.loadRun(bucket.runId)
      if (!run?.reservationId) {
        skipped++
        continue
      }
      let capturedRange = false
      while (true) {
        const intent = await this.deps.store.openCaptureIntent({
          runId: bucket.runId,
          bucketKey: bucket.bucketKey,
          now: this.deps.clock.now(),
        })
        if (!intent) {
          if (capturedRange) flushed++
          else skipped++
          break
        }

        try {
          await this.captureToWallet({
            reservationId: run.reservationId,
            projectId: run.projectId,
            customerId: run.customerId,
            currency: run.currency,
            amount: intent.amount,
            billingPeriodId: bucket.billingPeriodId,
            featurePlanVersionItemId: bucket.featurePlanVersionItemId,
            featureSlug: bucket.featureSlug,
            statementKey: bucket.statementKey,
            idempotencyKey: intent.intentKey,
            quantity: intent.captureQuantity,
            flushSeq: captureIntentFlushSeq(intent),
          })

          await this.deps.store.commitCaptureSuccess({
            amount: intent.amount,
            bucketKey: bucket.bucketKey,
            intentKey: intent.intentKey,
            runId: bucket.runId,
            updatedAt: this.deps.clock.now(),
          })
          capturedRange = true
        } catch (error) {
          const nextAttempt = intent.attemptCount + 1
          const nextStatus =
            nextAttempt >= MAX_CAPTURE_ATTEMPTS ? CAPTURE_ABANDONED_STATUS : "failed"

          await this.deps.store.markCaptureFailure({
            intentKey: intent.intentKey,
            status: nextStatus,
            attemptCount: nextAttempt,
            lastError: error instanceof Error ? error.message : "unknown",
            updatedAt: this.deps.clock.now(),
          })

          if (filter?.failOnCaptureError) throw error
          skipped++
          break
        }
      }
    }

    return { flushed, skipped }
  }

  /** Alarm handler: retry failed captures and expire runs. */
  async alarm(): Promise<void> {
    // Retry outstanding capture intents. No attemptCount cap here: intents that
    // exhausted their retries are already terminal `abandoned` and drop out of
    // the retryable status set, so this naturally stops chasing dead captures.
    await this.flushCaptures()

    // Close runs past their expiry. Only the DO can release the run's wallet
    // reservation, so this SQLite source-of-truth transition MUST stay here.
    // The Postgres row is a read model refreshed worker-side (on observation
    // via BudgetRunService.listRunsRefreshed + the budget-runs-refresh sweep),
    // so the DO no longer writes budget runs to Postgres at all.
    const now = this.deps.clock.now()
    const expiredRuns = await this.deps.store.findRunningRunsPastExpiry(now)

    for (const run of expiredRuns) {
      try {
        await this.closeRunInStorage({
          runId: run.runId,
          customerId: run.customerId,
          projectId: run.projectId,
          status: "expired",
          endedAt: now,
        })
      } catch (error) {
        // A run with unresolved captures must not finalize yet; its capture
        // retry alarm will re-drive it. Anything else is a genuine failure.
        if (error instanceof RunCapturesPendingError) {
          continue
        }
        throw error
      }

      // Clear the expiresAt marker so a finalized run never re-fires this branch.
      await this.deps.store.markExpiredRunFinalized(run.runId)
    }

    // Reschedule the capture retry (plus any run-expiration alarm). While ANY
    // retryable (pending|failed) intent remains, the capture alarm is always
    // rescheduled -- never null -- so outstanding captures can never be orphaned.
    // Backoff uses the LONGEST backoff among outstanding intents (the highest
    // attemptCount, capped at 1h) to avoid hammering a persistently failing wallet.
    const remaining = await this.deps.store.listRetryableCaptureIntents()
    const maxRemainingAttempt = remaining.reduce(
      (max, intent) => Math.max(max, intent.attemptCount),
      0
    )
    const nextCaptureAlarmAt =
      remaining.length > 0 ? now + captureBackoffMs(maxRemainingAttempt) : null
    const nextExpirationAlarmAt = await this.deps.store.findNextExpirationAlarmAt(now)
    const nextAlarmAt = [nextCaptureAlarmAt, nextExpirationAlarmAt]
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0]

    if (nextAlarmAt) {
      await this.deps.scheduler.setAlarm(nextAlarmAt)
    }
  }

  // --- Private methods ---

  private async closeRunInStorage(input: EndRunInput): Promise<{
    summary: RunBudgetSummary
    run: RunState
  }> {
    const run = await this.deps.store.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")

    if (run.status !== "running") {
      return {
        summary: this.toSummary(run),
        run,
      }
    }

    await this.flushCaptures()

    const afterFlush = await this.deps.store.loadRun(input.runId)
    if (!afterFlush) throw new Error("Run state missing after flush")

    if (await this.deps.store.hasUnresolvedCaptureIntents(input.runId)) {
      throw new RunCapturesPendingError(input.runId)
    }

    if (afterFlush.reservationId) {
      await this.releaseReservation(afterFlush)
    }

    // Captures that exhausted every retry are abandoned unbilled. Never close
    // silently over them: persist a reconciliation flag and emit an error log so
    // operators can settle the missing capture manually.
    const abandonedIntents = await this.deps.store.findAbandonedCaptureIntents(input.runId)
    const reconciliationNeeded = abandonedIntents.length > 0

    await this.deps.store.closeRun({
      runId: input.runId,
      status: input.status,
      endedAt: input.endedAt,
      reconciliationNeeded,
    })

    if (reconciliationNeeded) {
      await this.logAbandonedCaptures(afterFlush, abandonedIntents)
    }

    const final = await this.deps.store.loadRun(input.runId)
    if (!final) throw new Error("Run state missing after close")

    return {
      summary: this.toSummary(final),
      run: final,
    }
  }

  private async rejectExpiredRun(
    input: ApplyRunSyncEventInput,
    run: RunState
  ): Promise<RunBudgetDecision> {
    let summary: RunBudgetSummary

    try {
      const closed = await this.closeRunInStorage({
        runId: input.runId,
        customerId: input.customerId,
        projectId: input.projectId,
        status: "expired",
        endedAt: input.now,
      })
      summary = closed.summary
      await this.scheduleAlarm()
    } catch (error) {
      if (!(error instanceof RunCapturesPendingError)) {
        throw error
      }
      summary = this.toSummary(run)
    }

    return {
      allowed: false,
      state: "rejected",
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      message: `Run expired at ${new Date(run.expiresAt ?? input.now).toISOString()}`,
      budget: summary,
      meterFacts: [],
    }
  }

  private async logAbandonedCaptures(
    run: RunState,
    abandonedIntents: RunCaptureIntent[]
  ): Promise<void> {
    const abandonedAmount = abandonedIntents.reduce((sum, intent) => sum + intent.amount, 0)

    this.deps.logger.error("run closed with abandoned captures requiring reconciliation", {
      outcome: "error",
      recovery_required: true,
      run_id: run.runId,
      project_id: run.projectId,
      customer_id: run.customerId,
      abandoned_intent_keys: abandonedIntents.map((intent) => intent.intentKey),
      abandoned_capture_count: abandonedIntents.length,
      abandoned_amount: abandonedAmount,
      currency: run.currency,
    })
  }

  private async createRunReservation(
    input: ResolvedStartRunInput
  ): Promise<
    | { success: true; reservationId: string; allocationAmount: number }
    | { success: false; reason: string }
  > {
    const wallet = await this.deps.wallet.create()

    const result = await wallet.createReservation({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency as "USD" | "EUR",
      entitlementId: null,
      owner: { type: "agent_run", id: input.runId },
      requestedAmount: input.budgetAmount,
      minimumAllocationAmount: input.budgetAmount,
      refillThresholdBps: 2000,
      refillChunkAmount: input.budgetAmount,
      periodStartAt: new Date(input.now),
      periodEndAt: new Date(input.expiresAt),
      idempotencyKey: input.idempotencyKey,
      metadata: {
        run_id: input.runId,
        trace_id: input.traceId ?? null,
        parent_run_id: input.parentRunId ?? null,
        workload_type: input.workloadType ?? null,
        workload_id: input.workloadId ?? null,
      },
    })

    if (result.err) {
      const message = result.err.message ?? "unknown"
      return { success: false, reason: message }
    }

    return {
      success: true,
      reservationId: result.val.reservationId,
      allocationAmount: result.val.allocationAmount,
    }
  }

  /**
   * Creates fresh wallet operations for one external wallet use. The lazy Neon
   * WebSocket connection and services must never cross Worker/DO request boundaries.
   */
  private async callEntitlementWindow(
    input: ApplyRunSyncEventInput,
    remainingAmount: number,
    enforceLimit: boolean
  ) {
    // The entitlement and grants are validated upstream by the use case. The
    // EntitlementWindowDO re-parses them with its own applyInputSchema at the RPC boundary.
    return this.deps.pricing.apply({
      event: { ...input.event, source: input.source },
      idempotencyKey: `${input.idempotencyKey}:ew`,
      projectId: input.projectId,
      customerId: input.customerId,
      customerEntitlementId: input.customerEntitlementId,
      entitlement: input.entitlement,
      grants: input.grants,
      enforceLimit,
      now: input.now,
      wallet: { mode: "external_reservation", remainingAmount },
    })
  }

  private async captureToWallet(input: {
    reservationId: string
    projectId: string
    customerId: string
    currency: string
    amount: number
    billingPeriodId: string
    featurePlanVersionItemId: string
    featureSlug: string
    statementKey: string
    idempotencyKey: string
    quantity: number
    flushSeq: number
  }): Promise<void> {
    const wallet = await this.deps.wallet.create()

    const result = await wallet.captureReservationUsage({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency as "USD" | "EUR",
      reservationId: input.reservationId,
      flushSeq: input.flushSeq,
      amount: input.amount,
      billingPeriodId: input.billingPeriodId,
      statementKey: input.statementKey,
      kind: "usage",
      metadata: {
        billing_period_id: input.billingPeriodId,
        feature_plan_version_item_id: input.featurePlanVersionItemId,
        feature_slug: input.featureSlug,
        idempotency_key: input.idempotencyKey,
        quantity: input.quantity,
      },
      sourceId: input.idempotencyKey,
    })

    if (result.err) throw result.err
  }

  private async releaseReservation(run: RunState): Promise<void> {
    const wallet = await this.deps.wallet.create()

    const result = await wallet.releaseReservation({
      projectId: run.projectId,
      customerId: run.customerId,
      currency: run.currency as "USD" | "EUR",
      reservationId: run.reservationId!,
      closeReason: "period_close",
      idempotencyKey: `release:${run.runId}:${run.reservationId}`,
      metadata: {
        run_id: run.runId,
        trace_id: run.traceId,
        parent_run_id: run.parentRunId,
        workload_type: run.workloadType,
        workload_id: run.workloadId,
      },
    })

    if (result.err) throw result.err
  }

  private withRunContext(run: RunState, meterFacts: RunBudgetMeterFact[]): RunBudgetMeterFact[] {
    const workloadType = startRunInputSchema.shape.workloadType.parse(run.workloadType)

    return meterFacts.map((fact) => ({
      ...fact,
      run_id: run.runId,
      trace_id: run.traceId ?? null,
      parent_run_id: run.parentRunId ?? null,
      workload_type: workloadType ?? null,
      workload_id: run.workloadId ?? null,
    }))
  }

  private sumPricedAmount(meterFacts: RunBudgetMeterFact[]): number {
    return meterFacts.reduce((sum, fact) => sum + fact.amount, 0)
  }

  private deriveBucketDeltas(
    run: Pick<RunState, "runId" | "currency">,
    entitlement: ApplyRunSyncEventInput["entitlement"],
    meterFacts: RunBudgetMeterFact[]
  ): RunSpendBucketDelta[] {
    return meterFacts.flatMap((fact) => {
      if (fact.amount <= 0) return []

      const invoiceContext = this.resolveBillingPeriodContext(entitlement, fact.timestamp)
      const bucketKey = [
        run.runId,
        fact.customer_entitlement_id,
        invoiceContext.statementKey,
        fact.period_key,
      ].join(":")

      return {
        bucketKey,
        billingPeriodId: invoiceContext.billingPeriodId,
        entitlementId: fact.customer_entitlement_id,
        featureId: null,
        featurePlanVersionItemId: invoiceContext.featurePlanVersionItemId,
        featureSlug: fact.feature_slug,
        statementKey: invoiceContext.statementKey,
        periodStartAt: invoiceContext.cycleStartAt,
        periodEndAt: invoiceContext.cycleEndAt,
        quantity: fact.delta,
        currency: run.currency,
        amount: fact.amount,
      }
    })
  }

  private allocateFundedBucketDeltas(
    bucketDeltas: RunSpendBucketDelta[],
    fundedAmount: number
  ): RunSpendBucketDelta[] {
    let remaining = fundedAmount

    return bucketDeltas.flatMap((delta) => {
      if (remaining <= 0 || delta.amount <= 0) return []

      const amount = Math.min(delta.amount, remaining)
      remaining -= amount

      return [
        {
          ...delta,
          amount,
          quantity: delta.quantity * (amount / delta.amount),
        },
      ]
    })
  }

  private resolveBillingPeriodContext(
    entitlement: ApplyRunSyncEventInput["entitlement"],
    eventTimestamp: number
  ): ApplyRunSyncEventInput["entitlement"]["billingPeriods"][number] {
    const period = findBillingPeriodAt(entitlement.billingPeriods, eventTimestamp)

    if (!period) {
      throw new Error(
        `Missing billing period invoice context for run spend event at ${eventTimestamp}`
      )
    }

    return period
  }

  private rejectMissingBillingPeriodContext(
    input: ApplyRunSyncEventInput,
    run: RunState
  ): RunBudgetDecision | null {
    const billingPeriod = findBillingPeriodAt(
      input.entitlement.billingPeriods,
      input.event.timestamp
    )

    if (billingPeriod) {
      return null
    }

    return {
      allowed: false,
      state: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
      message: "No active billing period covers this event timestamp",
      budget: this.toSummary(run),
      meterFacts: [],
    }
  }

  private projectRunSpend(run: RunState, pricedAmount: number, now: number): RunState {
    return {
      ...run,
      consumedAmount: run.consumedAmount + pricedAmount,
      lastEventAt: now,
    }
  }

  private async commitSpendAndIdempotency(
    run: RunState,
    updatedRun: RunState,
    idempotencyKey: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[]
  ): Promise<void> {
    await this.deps.store.commitSpendAndIdempotency({
      run,
      updatedRun,
      idempotencyKey,
      decision,
      pricedAmount,
      bucketDeltas,
      createdAt: this.deps.clock.now(),
    })
  }

  private toSummary(run: RunState): RunBudgetSummary {
    return {
      runId: run.runId,
      status: run.status,
      endedAt: run.endedAt,
      budgetAmount: run.budgetAmount,
      consumedAmount: run.consumedAmount,
      remainingAmount: Math.max(0, run.budgetAmount - run.consumedAmount),
      walletReservationId: run.reservationId ?? null,
      reconciliationNeeded: Boolean(run.reconciliationNeeded),
    }
  }

  private async scheduleAlarm(delayMs = 10_000): Promise<void> {
    await this.scheduleAlarmAt(this.deps.clock.now() + delayMs)
  }

  private async repairAcceptedReplayAlarm(
    run: RunState | undefined,
    decision: RunBudgetDecision
  ): Promise<void> {
    if (!decision.allowed || run?.status !== "running") return

    if (run.expiresAt !== null) {
      await this.scheduleAlarmAt(Math.max(this.deps.clock.now(), run.expiresAt))
    }
    if (await this.deps.store.hasCaptureableSpend(run.runId)) {
      await this.scheduleAlarm()
    }
  }

  private async scheduleAlarmAt(timestamp: number): Promise<void> {
    const currentAlarm = await this.deps.scheduler.getAlarm()
    if (!currentAlarm || timestamp < currentAlarm) {
      await this.deps.scheduler.setAlarm(timestamp)
    }
  }
}
