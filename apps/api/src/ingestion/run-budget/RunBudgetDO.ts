import { DurableObject } from "cloudflare:workers"
import { eq, inArray, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import {
  CAPTURE_ABANDONED_STATUS,
  CAPTURE_RETRY_STATUSES,
  MAX_CAPTURE_ATTEMPTS,
  captureBackoffMs,
} from "./capture-policy"
import {
  type ApplyRunSyncEventInput,
  type EndRunInput,
  type FlushRunBudgetCapturesForInvoicingInput,
  type FlushRunBudgetCapturesForInvoicingResult,
  type GetRunStatusInput,
  type RunBudgetDecision,
  type RunBudgetSummary,
  type StartRunInput,
  applyRunSyncEventInputSchema,
  endRunInputSchema,
  flushRunBudgetCapturesForInvoicingInputSchema,
  getRunStatusInputSchema,
  startRunInputSchema,
} from "./contracts"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"
import type { RunBudgetPricingDelegate, RunBudgetWalletOps } from "./ports"

type RunStateRow = typeof schema.runState.$inferSelect
type RunCaptureIntentRow = typeof schema.runCaptureIntents.$inferSelect
type RunBudgetDbWriter = Pick<DrizzleSqliteDODatabase<typeof schema>, "insert" | "update">
type RunSpendBucketDelta = {
  amount: number
  billingPeriodId: string
  bucketKey: string
  currency: string
  entitlementId: string
  featureId: string | null
  featurePlanVersionItemId: string
  featureSlug: string
  periodEndAt: number
  periodStartAt: number
  quantity: number
  statementKey: string
}

class RunCapturesPendingError extends Error {
  constructor(runId: string) {
    super(`Unresolved capture intents remain for run ${runId}`)
    this.name = "RunCapturesPendingError"
  }
}

export class RunBudgetDO extends DurableObject {
  private readonly ready: Promise<void>
  private readonly db: DrizzleSqliteDODatabase<typeof schema>
  private readonly pricing: RunBudgetPricingDelegate

  constructor(
    state: DurableObjectState,
    private readonly runtimeEnv: Env
  ) {
    super(state, runtimeEnv as unknown as Cloudflare.Env)
    this.pricing = {
      apply: async (input) => {
        const entitlementWindowId = this.runtimeEnv.entitlementwindow.idFromName(
          `${this.runtimeEnv.APP_ENV}:${input.projectId}:${input.customerId}:${input.customerEntitlementId}`
        )
        const entitlementWindow = this.runtimeEnv.entitlementwindow.get(entitlementWindowId)

        return entitlementWindow.apply({
          event: input.event,
          idempotencyKey: input.idempotencyKey,
          projectId: input.projectId,
          customerId: input.customerId,
          entitlement: input.entitlement,
          grants: input.grants,
          enforceLimit: input.enforceLimit,
          now: input.now,
          walletMode: "external_reservation",
          externalReservation: input.externalReservation,
        })
      },
    }
    this.db = drizzle(this.ctx.storage, { schema, logger: false })
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations)
    })
  }

  async startRun(rawInput: StartRunInput): Promise<RunBudgetSummary> {
    await this.ready
    const input = startRunInputSchema.parse(rawInput)

    // Idempotent: if run already exists, return current state
    const existing = await this.loadRun(input.runId)
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
    await this.db.insert(schema.runState).values({
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
      startedAt: input.now,
      expiresAt: input.expiresAt ?? null,
      traceId: input.traceId ?? null,
      metadataJson: JSON.stringify(input.metadata),
    })

    if (input.expiresAt) {
      await this.scheduleAlarmAt(input.expiresAt)
    }

    const run = await this.loadRun(input.runId)
    if (!run) throw new Error("Run state missing after startRun insert")
    return this.toSummary(run)
  }

  async applySyncEvent(rawInput: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    await this.ready
    const input = applyRunSyncEventInputSchema.parse(rawInput)

    return this.ctx.blockConcurrencyWhile(() => this.applySyncEventLocked(input))
  }

  private async applySyncEventLocked(input: ApplyRunSyncEventInput): Promise<RunBudgetDecision> {
    // Check idempotency
    const cached = await this.db.query.runIdempotency.findFirst({
      where: eq(schema.runIdempotency.idempotencyKey, input.idempotencyKey),
    })
    if (cached) {
      const decision = JSON.parse(cached.decisionJson) as RunBudgetDecision

      // Rolling-deploy repair: an older DO may have cached a terminal decision
      // before summaries carried endedAt. Rehydrate only the missing timestamp
      // from this DO's authoritative run state; every cached decision field
      // remains unchanged.
      if (decision.budget.status !== "running" && decision.budget.endedAt == null) {
        const run = await this.loadRun(input.runId)
        if (
          run?.runId === decision.budget.runId &&
          run.status !== "running" &&
          run.endedAt != null
        ) {
          return {
            ...decision,
            budget: { ...decision.budget, endedAt: run.endedAt },
            meterFacts: decision.meterFacts ?? [],
          }
        }
      }

      return { ...decision, meterFacts: decision.meterFacts ?? [] }
    }

    // Load run state
    const run = await this.loadRun(input.runId)
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
      await this.persistIdempotency(this.db, input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }
    if (run.expiresAt !== null && run.expiresAt <= input.now) {
      const decision = await this.rejectExpiredRun(input, run)
      await this.persistIdempotency(this.db, input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }

    // Compute remaining budget
    const remainingAmount = Math.max(0, run.budgetAmount - run.consumedAmount)

    const missingBillingPeriodDecision = this.rejectMissingBillingPeriodContext(input, run)
    if (missingBillingPeriodDecision) {
      await this.persistIdempotency(
        this.db,
        input.idempotencyKey,
        input.runId,
        missingBillingPeriodDecision,
        0,
        []
      )
      return missingBillingPeriodDecision
    }

    // Delegate pricing to EntitlementWindowDO with external reservation mode
    const entitlementResult = await this.callEntitlementWindow(input, remainingAmount)

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
      await this.persistIdempotency(this.db, input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }

    // Derive priced cost from meter facts
    const rawMeterFacts = entitlementResult.meterFacts ?? []
    const meterFacts = this.withRunContext(run, rawMeterFacts)
    const pricedAmount = this.sumPricedAmount(meterFacts)
    const bucketDeltas = this.deriveBucketDeltas(input.runId, input.entitlement, meterFacts)

    const updatedRun = this.projectRunSpend(run, pricedAmount, input.now)
    const decision: RunBudgetDecision = {
      allowed: true,
      state: "processed",
      budget: this.toSummary(updatedRun),
      meterFacts: meterFacts as RunBudgetDecision["meterFacts"],
    }

    await this.commitSpendAndIdempotency(
      run,
      updatedRun,
      input.idempotencyKey,
      decision,
      pricedAmount,
      bucketDeltas
    )

    // Schedule alarm for capture flush if there's pending spend
    if (updatedRun.consumedAmount > updatedRun.flushedAmount) {
      await this.scheduleAlarm()
    }

    return decision
  }

  async endRun(rawInput: EndRunInput): Promise<RunBudgetSummary> {
    await this.ready
    const input = endRunInputSchema.parse(rawInput)

    const { summary } = await this.closeRunInStorage(input)
    return summary
  }

  async getRunStatus(rawInput: GetRunStatusInput): Promise<RunBudgetSummary> {
    await this.ready
    const input = getRunStatusInputSchema.parse(rawInput)
    const run = await this.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")
    return this.toSummary(run)
  }

  /** Flush pending captures to wallet. Called by alarm and endRun. */
  async flushCaptures(): Promise<void> {
    await this.ready
    await this.flushCaptureBuckets()
  }

  /** Flush pending captures for one invoice statement before invoice materialization. */
  async flushCapturesForInvoicing(
    rawInput: FlushRunBudgetCapturesForInvoicingInput
  ): Promise<FlushRunBudgetCapturesForInvoicingResult> {
    await this.ready
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

    // Get all unflushed buckets
    const unfilteredBuckets = await this.db.query.runSpendBuckets.findMany({
      where: sql`${schema.runSpendBuckets.consumedAmount} > ${schema.runSpendBuckets.flushedAmount}`,
    })
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
      const pendingAmount = bucket.consumedAmount - bucket.flushedAmount
      if (pendingAmount <= 0) {
        skipped++
        continue
      }

      const run = await this.loadRun(bucket.runId)
      if (!run?.reservationId) {
        skipped++
        continue
      }

      const intentKey = `run-capture:${bucket.runId}:${bucket.bucketKey}:${bucket.flushedAmount}`

      const now = Date.now()

      // Skip-guard: a capture that exhausted its retries is terminal. Never
      // resurrect it back to `pending` (which would loop forever) -- leave it
      // abandoned so the run can close with a reconciliation flag instead.
      const existingIntent = await this.loadCaptureIntent(intentKey)
      if (existingIntent?.status === CAPTURE_ABANDONED_STATUS) {
        skipped++
        continue
      }

      // Persist capture intent before external I/O. On conflict, keep the original
      // amount snapshot so wallet replay never changes payload for the same key.
      await this.db
        .insert(schema.runCaptureIntents)
        .values({
          intentKey,
          runId: bucket.runId,
          bucketKey: bucket.bucketKey,
          amount: pendingAmount,
          status: "pending",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.runCaptureIntents.intentKey,
          set: {
            status: "pending",
            updatedAt: now,
          },
        })

      const intent = await this.loadCaptureIntent(intentKey)
      if (!intent) throw new Error("Run capture intent missing after insert")

      try {
        // External wallet capture
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
          idempotencyKey: intentKey,
          quantity: bucket.quantity,
          flushSeq: intent.createdAt,
        })

        // Mark intent as captured and update bucket flushed amount
        await this.db
          .update(schema.runCaptureIntents)
          .set({ status: "captured", updatedAt: Date.now() })
          .where(eq(schema.runCaptureIntents.intentKey, intentKey))

        await this.db
          .update(schema.runSpendBuckets)
          .set({
            flushedAmount: sql`${schema.runSpendBuckets.flushedAmount} + ${intent.amount}`,
          })
          .where(eq(schema.runSpendBuckets.bucketKey, bucket.bucketKey))

        // Update run-level flushed amount
        await this.db
          .update(schema.runState)
          .set({
            flushedAmount: sql`${schema.runState.flushedAmount} + ${intent.amount}`,
          })
          .where(eq(schema.runState.runId, bucket.runId))
      } catch (error) {
        // Record the failed attempt. Once we reach the attempt cap the intent
        // becomes terminal `abandoned`: it will never be retried again and no
        // longer blocks the run from closing (see closeRunInStorage). attemptCount
        // is preserved across the flush upsert, so this count is stable per intent.
        const nextAttempt = intent.attemptCount + 1
        const nextStatus = nextAttempt >= MAX_CAPTURE_ATTEMPTS ? CAPTURE_ABANDONED_STATUS : "failed"

        await this.db
          .update(schema.runCaptureIntents)
          .set({
            status: nextStatus,
            attemptCount: nextAttempt,
            lastError: error instanceof Error ? error.message : "unknown",
            updatedAt: Date.now(),
          })
          .where(eq(schema.runCaptureIntents.intentKey, intentKey))

        if (filter?.failOnCaptureError) {
          throw error
        }

        skipped++
        continue
      }

      flushed++
    }

    return { flushed, skipped }
  }

  /** Alarm handler: retry failed captures and expire runs. */
  override async alarm(): Promise<void> {
    await this.ready

    // Retry outstanding capture intents. No attemptCount cap here: intents that
    // exhausted their retries are already terminal `abandoned` and drop out of
    // the retryable status set, so this naturally stops chasing dead captures.
    const pendingIntents = await this.db.query.runCaptureIntents.findMany({
      where: this.retryableCaptureIntentsWhere(),
    })

    if (pendingIntents.length > 0) {
      await this.flushCaptures()
    }

    // Close runs past their expiry. Only the DO can release the run's wallet
    // reservation, so this SQLite source-of-truth transition MUST stay here.
    // The Postgres row is a read model refreshed worker-side (on observation
    // via BudgetRunService.listRunsRefreshed + the budget-runs-refresh sweep),
    // so the DO no longer writes budget runs to Postgres at all.
    const now = Date.now()
    const expiredRuns = await this.findRunningRunsPastExpiry(now)

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
      await this.markExpiredRunFinalized(run)
    }

    // Reschedule the capture retry (plus any run-expiration alarm). While ANY
    // retryable (pending|failed) intent remains, the capture alarm is always
    // rescheduled -- never null -- so outstanding captures can never be orphaned.
    // Backoff uses the LONGEST backoff among outstanding intents (the highest
    // attemptCount, capped at 1h) to avoid hammering a persistently failing wallet.
    const remaining = await this.db.query.runCaptureIntents.findMany({
      where: this.retryableCaptureIntentsWhere(),
    })
    const maxRemainingAttempt = remaining.reduce(
      (max, intent) => Math.max(max, intent.attemptCount),
      0
    )
    const nextCaptureAlarmAt =
      remaining.length > 0 ? now + captureBackoffMs(maxRemainingAttempt) : null
    const nextExpirationAlarmAt = await this.findNextExpirationAlarmAt(now)
    const nextAlarmAt = [nextCaptureAlarmAt, nextExpirationAlarmAt]
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0]

    if (nextAlarmAt) {
      await this.ctx.storage.setAlarm(nextAlarmAt)
    }
  }

  // --- Private methods ---

  private async closeRunInStorage(input: EndRunInput): Promise<{
    summary: RunBudgetSummary
    run: RunStateRow
  }> {
    const run = await this.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")

    if (run.status !== "running") {
      return {
        summary: this.toSummary(run),
        run,
      }
    }

    await this.flushCaptures()

    const afterFlush = await this.loadRun(input.runId)
    if (!afterFlush) throw new Error("Run state missing after flush")

    if (await this.hasUnresolvedCaptureIntents(input.runId)) {
      throw new RunCapturesPendingError(input.runId)
    }

    if (afterFlush.reservationId) {
      await this.releaseReservation(afterFlush)
    }

    // Captures that exhausted every retry are abandoned unbilled. Never close
    // silently over them: persist a reconciliation flag and emit an error log so
    // operators can settle the missing capture manually.
    const abandonedIntents = await this.findAbandonedCaptureIntents(input.runId)
    const reconciliationNeeded = abandonedIntents.length > 0

    await this.db
      .update(schema.runState)
      .set({
        status: input.status,
        endedAt: input.endedAt,
        reconciliationNeeded,
      })
      .where(eq(schema.runState.runId, input.runId))

    if (reconciliationNeeded) {
      await this.logAbandonedCaptures(afterFlush, abandonedIntents)
    }

    const final = await this.loadRun(input.runId)
    if (!final) throw new Error("Run state missing after close")

    return {
      summary: this.toSummary(final),
      run: final,
    }
  }

  private async rejectExpiredRun(
    input: ApplyRunSyncEventInput,
    run: RunStateRow
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

  private async findRunningRunsPastExpiry(now: number): Promise<RunStateRow[]> {
    return this.db.query.runState.findMany({
      where: sql`
        ${schema.runState.status} = 'running'
        AND ${schema.runState.expiresAt} IS NOT NULL
        AND ${schema.runState.expiresAt} <= ${now}
      `,
    })
  }

  /**
   * SQLite-side bookkeeping: clear the expiresAt marker once a run has been
   * finalized so the expiry sweep in `alarm()` never re-selects it. This is the
   * only "summary needs finalizing" state the DO keeps — there is no Postgres
   * write here; the read model is refreshed worker-side.
   */
  private async markExpiredRunFinalized(run: RunStateRow): Promise<void> {
    await this.db
      .update(schema.runState)
      .set({
        expiresAt: null,
      })
      .where(eq(schema.runState.runId, run.runId))
  }

  /**
   * The single retryable-status predicate shared by every capture query so the
   * "which intents are still open" rule is defined exactly once. Terminal
   * statuses (`captured`, `abandoned`) are excluded.
   */
  private retryableCaptureIntentsWhere() {
    return inArray(schema.runCaptureIntents.status, [...CAPTURE_RETRY_STATUSES])
  }

  private async hasUnresolvedCaptureIntents(runId: string): Promise<boolean> {
    const intents = await this.db.query.runCaptureIntents.findMany({
      where: this.retryableCaptureIntentsWhere(),
    })

    return intents.some((intent) => this.intentBelongsToRun(intent, runId))
  }

  private async findAbandonedCaptureIntents(runId: string): Promise<RunCaptureIntentRow[]> {
    const intents = await this.db.query.runCaptureIntents.findMany({
      where: eq(schema.runCaptureIntents.status, CAPTURE_ABANDONED_STATUS),
    })

    return intents.filter((intent) => this.intentBelongsToRun(intent, runId))
  }

  private intentBelongsToRun(intent: RunCaptureIntentRow, runId: string): boolean {
    return intent.runId === runId || intent.intentKey.startsWith(`run-capture:${runId}:`)
  }

  private async logAbandonedCaptures(
    run: RunStateRow,
    abandonedIntents: RunCaptureIntentRow[]
  ): Promise<void> {
    const { createDoLogger } = await import("~/observability")
    const logger = createDoLogger(this.ctx.id.toString())
    const abandonedAmount = abandonedIntents.reduce((sum, intent) => sum + intent.amount, 0)

    logger.error("run closed with abandoned captures requiring reconciliation", {
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

  private async findNextExpirationAlarmAt(now: number): Promise<number | null> {
    const runs = await this.db.query.runState.findMany({
      where: sql`${schema.runState.status} = 'running' AND ${schema.runState.expiresAt} IS NOT NULL AND ${schema.runState.expiresAt} > ${now}`,
    })

    return runs.reduce<number | null>((next, run) => {
      if (!run.expiresAt) return next
      return next === null || run.expiresAt < next ? run.expiresAt : next
    }, null)
  }

  private async createRunReservation(
    input: StartRunInput
  ): Promise<
    | { success: true; reservationId: string; allocationAmount: number }
    | { success: false; reason: string }
  > {
    const wallet = await this.createWalletOps()

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
      periodEndAt: new Date(input.expiresAt ?? input.now + 24 * 60 * 60 * 1000),
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
  private async createWalletOps(): Promise<RunBudgetWalletOps> {
    const { createConnection } = await import("@unprice/db")
    const { WalletService } = await import("@unprice/services/wallet")
    const { LedgerGateway } = await import("@unprice/services/ledger")

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
      singleton: false,
    })

    const { createDoLogger } = await import("~/observability")
    const logger = createDoLogger(this.ctx.id.toString())

    const ledger = new LedgerGateway({ db, logger })
    return new WalletService({ db, logger, ledgerGateway: ledger })
  }

  private async callEntitlementWindow(input: ApplyRunSyncEventInput, remainingAmount: number) {
    // The entitlement and grants are validated upstream by the use case. The
    // EntitlementWindowDO re-parses them with its own applyInputSchema at the RPC boundary.
    return this.pricing.apply({
      event: { ...input.event, source: input.source },
      idempotencyKey: `${input.idempotencyKey}:ew`,
      projectId: input.projectId,
      customerId: input.customerId,
      customerEntitlementId: input.customerEntitlementId,
      entitlement: input.entitlement,
      grants: input.grants,
      enforceLimit: true,
      now: input.now,
      externalReservation: { remainingAmount },
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
    const wallet = await this.createWalletOps()

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

  private async releaseReservation(run: RunStateRow): Promise<void> {
    const wallet = await this.createWalletOps()

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

  private withRunContext(
    run: RunStateRow,
    meterFacts: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    return meterFacts.map((fact) => ({
      ...fact,
      run_id: run.runId,
      trace_id: run.traceId ?? null,
      parent_run_id: run.parentRunId ?? null,
      workload_type: run.workloadType ?? null,
      workload_id: run.workloadId ?? null,
    }))
  }

  private sumPricedAmount(meterFacts: Record<string, unknown>[]): number {
    return meterFacts.reduce(
      (sum: number, fact: Record<string, unknown>) => sum + ((fact.amount as number) ?? 0),
      0
    )
  }

  private deriveBucketDeltas(
    runId: string,
    entitlement: ApplyRunSyncEventInput["entitlement"],
    meterFacts: Record<string, unknown>[]
  ): RunSpendBucketDelta[] {
    return meterFacts.flatMap((fact: Record<string, unknown>) => {
      const amount = this.readFactNumber(fact, "amount") ?? 0
      if (amount <= 0) return []

      const statementKey = this.readFactString(fact, "statement_key")
      const periodKey = this.readFactString(fact, "period_key") ?? "unknown"
      const invoiceContext = this.resolveBillingPeriodContext({
        entitlement,
        fact,
        statementKey,
      })
      const bucketKey = [
        runId,
        this.readFactString(fact, "customer_entitlement_id") ?? "unknown",
        invoiceContext.statementKey,
        periodKey,
      ].join(":")

      return {
        bucketKey,
        billingPeriodId: invoiceContext.billingPeriodId,
        entitlementId: this.readFactString(fact, "customer_entitlement_id") ?? "unknown",
        featureId: this.readFactString(fact, "feature_id"),
        featurePlanVersionItemId: invoiceContext.featurePlanVersionItemId,
        featureSlug: this.readFactString(fact, "feature_slug") ?? entitlement.featureSlug,
        statementKey: invoiceContext.statementKey,
        periodStartAt: this.readFactNumber(fact, "period_start_at") ?? invoiceContext.cycleStartAt,
        periodEndAt: this.readFactNumber(fact, "period_end_at") ?? invoiceContext.cycleEndAt,
        quantity: this.readFactNumber(fact, "delta") ?? 0,
        currency: this.readFactString(fact, "currency") ?? "USD",
        amount,
      }
    })
  }

  private readFactString(fact: Record<string, unknown>, key: string): string | null {
    const value = fact[key]
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") return null
    return trimmed
  }

  private readFactNumber(fact: Record<string, unknown>, key: string): number | null {
    const value = fact[key]
    return typeof value === "number" && Number.isFinite(value) ? value : null
  }

  private resolveBillingPeriodContext(params: {
    entitlement: ApplyRunSyncEventInput["entitlement"]
    fact: Record<string, unknown>
    statementKey: string | null
  }): ApplyRunSyncEventInput["entitlement"]["billingPeriods"][number] {
    const eventTimestamp = this.readFactNumber(params.fact, "timestamp")
    const period = params.entitlement.billingPeriods.find((candidate) => {
      if (params.statementKey) return candidate.statementKey === params.statementKey
      return (
        eventTimestamp !== null &&
        candidate.cycleStartAt <= eventTimestamp &&
        eventTimestamp < candidate.cycleEndAt
      )
    })

    if (!period) {
      throw new Error(
        `Missing billing period invoice context for run spend statement ${params.statementKey ?? "unknown"}`
      )
    }

    return period
  }

  private rejectMissingBillingPeriodContext(
    input: ApplyRunSyncEventInput,
    run: RunStateRow
  ): RunBudgetDecision | null {
    const billingPeriod = input.entitlement.billingPeriods.find(
      (period) =>
        period.cycleStartAt <= input.event.timestamp && input.event.timestamp < period.cycleEndAt
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

  private projectRunSpend(run: RunStateRow, pricedAmount: number, now: number): RunStateRow {
    return {
      ...run,
      consumedAmount: run.consumedAmount + pricedAmount,
      lastEventAt: now,
    }
  }

  private async commitSpendAndIdempotency(
    run: RunStateRow,
    updatedRun: RunStateRow,
    idempotencyKey: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[]
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.persistSpend(tx, run, updatedRun, bucketDeltas)
      await this.persistIdempotency(
        tx,
        idempotencyKey,
        run.runId,
        decision,
        pricedAmount,
        bucketDeltas
      )
    })
  }

  private async persistSpend(
    db: RunBudgetDbWriter,
    run: RunStateRow,
    updatedRun: RunStateRow,
    bucketDeltas: RunSpendBucketDelta[]
  ): Promise<void> {
    await db
      .update(schema.runState)
      .set({
        consumedAmount: updatedRun.consumedAmount,
        lastEventAt: updatedRun.lastEventAt,
      })
      .where(eq(schema.runState.runId, run.runId))

    // Upsert spend buckets
    for (const delta of bucketDeltas) {
      await db
        .insert(schema.runSpendBuckets)
        .values({
          bucketKey: delta.bucketKey,
          runId: run.runId,
          entitlementId: delta.entitlementId,
          featureId: delta.featureId,
          statementKey: delta.statementKey,
          billingPeriodId: delta.billingPeriodId,
          featurePlanVersionItemId: delta.featurePlanVersionItemId,
          featureSlug: delta.featureSlug,
          quantity: delta.quantity,
          periodStartAt: delta.periodStartAt,
          periodEndAt: delta.periodEndAt,
          currency: delta.currency,
          consumedAmount: delta.amount,
          flushedAmount: 0,
          pendingAmount: delta.amount,
        })
        .onConflictDoUpdate({
          target: schema.runSpendBuckets.bucketKey,
          set: {
            consumedAmount: sql`${schema.runSpendBuckets.consumedAmount} + ${delta.amount}`,
            pendingAmount: sql`${schema.runSpendBuckets.pendingAmount} + ${delta.amount}`,
          },
        })
    }
  }

  private async persistIdempotency(
    db: RunBudgetDbWriter,
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: unknown[]
  ): Promise<void> {
    await db
      .insert(schema.runIdempotency)
      .values({
        idempotencyKey,
        runId,
        decisionJson: JSON.stringify(decision),
        pricedAmount,
        bucketDeltasJson: JSON.stringify(bucketDeltas),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
  }

  private async loadRun(runId: string): Promise<RunStateRow | undefined> {
    return this.db.query.runState.findFirst({
      where: eq(schema.runState.runId, runId),
    })
  }

  private async loadCaptureIntent(intentKey: string): Promise<RunCaptureIntentRow | undefined> {
    return this.db.query.runCaptureIntents.findFirst({
      where: eq(schema.runCaptureIntents.intentKey, intentKey),
    })
  }

  private toSummary(run: RunStateRow): RunBudgetSummary {
    return {
      runId: run.runId,
      status: run.status as RunBudgetSummary["status"],
      endedAt: run.endedAt,
      budgetAmount: run.budgetAmount,
      consumedAmount: run.consumedAmount,
      remainingAmount: Math.max(0, run.budgetAmount - run.consumedAmount),
      walletReservationId: run.reservationId ?? null,
      reconciliationNeeded: Boolean(run.reconciliationNeeded),
    }
  }

  private async scheduleAlarm(delayMs = 10_000): Promise<void> {
    await this.scheduleAlarmAt(Date.now() + delayMs)
  }

  private async scheduleAlarmAt(timestamp: number): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm()
    if (!currentAlarm || timestamp < currentAlarm) {
      await this.ctx.storage.setAlarm(timestamp)
    }
  }
}
