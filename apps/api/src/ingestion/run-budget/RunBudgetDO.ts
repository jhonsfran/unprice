import { DurableObject } from "cloudflare:workers"
import { eq, sql } from "drizzle-orm"
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import type { Env } from "~/env"
import {
  type ApplyRunSyncEventInput,
  type EndRunInput,
  type GetRunStatusInput,
  type RunBudgetDecision,
  type RunBudgetSummary,
  type StartRunInput,
  applyRunSyncEventInputSchema,
  endRunInputSchema,
  getRunStatusInputSchema,
  startRunInputSchema,
} from "./contracts"
import * as schema from "./db/schema"
import migrations from "./drizzle/migrations"

type RunStateRow = typeof schema.runState.$inferSelect
type RunCaptureIntentRow = typeof schema.runCaptureIntents.$inferSelect

class RunCapturesPendingError extends Error {
  constructor(runId: string) {
    super(`Unresolved capture intents remain for run ${runId}`)
    this.name = "RunCapturesPendingError"
  }
}

export class RunBudgetDO extends DurableObject {
  private readonly ready: Promise<void>
  private readonly db: DrizzleSqliteDODatabase<typeof schema>

  constructor(
    state: DurableObjectState,
    private readonly runtimeEnv: Env
  ) {
    super(state, runtimeEnv as unknown as Cloudflare.Env)
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

    // Check idempotency
    const cached = await this.db.query.runIdempotency.findFirst({
      where: eq(schema.runIdempotency.idempotencyKey, input.idempotencyKey),
    })
    if (cached) {
      const decision = JSON.parse(cached.decisionJson) as RunBudgetDecision
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
      await this.persistIdempotency(input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }
    if (run.expiresAt !== null && run.expiresAt <= input.now) {
      const decision = await this.rejectExpiredRun(input, run)
      await this.persistIdempotency(input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }

    // Compute remaining budget
    const remainingAmount = Math.max(0, run.budgetAmount - run.consumedAmount)

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
      await this.persistIdempotency(input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }

    // Derive priced cost from meter facts
    const rawMeterFacts = entitlementResult.meterFacts ?? []
    const meterFacts = this.withRunContext(run, rawMeterFacts)
    const pricedAmount = this.sumPricedAmount(meterFacts)
    const bucketDeltas = this.deriveBucketDeltas(input.runId, meterFacts)

    // Update run spend and buckets in one transaction
    const updatedRun = await this.commitSpend(run, pricedAmount, bucketDeltas, input.now)

    const decision: RunBudgetDecision = {
      allowed: true,
      state: "processed",
      budget: this.toSummary(updatedRun),
      meterFacts: meterFacts as RunBudgetDecision["meterFacts"],
    }

    await this.persistIdempotency(
      input.idempotencyKey,
      input.runId,
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

    // Get all unflushed buckets
    const buckets = await this.db.query.runSpendBuckets.findMany({
      where: sql`${schema.runSpendBuckets.consumedAmount} > ${schema.runSpendBuckets.flushedAmount}`,
    })

    for (const bucket of buckets) {
      const pendingAmount = bucket.consumedAmount - bucket.flushedAmount
      if (pendingAmount <= 0) continue

      const run = await this.loadRun(bucket.runId)
      if (!run?.reservationId) continue

      const intentKey = `run-capture:${bucket.runId}:${bucket.bucketKey}:${bucket.flushedAmount}`

      const now = Date.now()

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
          statementKey: bucket.statementKey,
          idempotencyKey: intentKey,
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
        // Mark intent as failed for retry
        await this.db
          .update(schema.runCaptureIntents)
          .set({
            status: "failed",
            attemptCount: sql`${schema.runCaptureIntents.attemptCount} + 1`,
            lastError: error instanceof Error ? error.message : "unknown",
            updatedAt: Date.now(),
          })
          .where(eq(schema.runCaptureIntents.intentKey, intentKey))
      }
    }
  }

  /** Alarm handler: retry failed captures and expire runs. */
  override async alarm(): Promise<void> {
    await this.ready

    // Retry pending/failed capture intents
    const pendingIntents = await this.db.query.runCaptureIntents.findMany({
      where: sql`${schema.runCaptureIntents.status} IN ('pending', 'failed') AND ${schema.runCaptureIntents.attemptCount} < 5`,
    })

    if (pendingIntents.length > 0) {
      await this.flushCaptures()
    }

    let hasPersistenceFailures = false

    // Expire runs past their expiry time and retry summaries that failed to persist externally.
    const now = Date.now()
    const expiredRuns = await this.findExpiredRunsNeedingSummaryPersistence(now)

    for (const run of expiredRuns) {
      let summary: RunBudgetSummary
      let closedRun: RunStateRow

      if (run.status === "running") {
        try {
          const closed = await this.closeRunInStorage({
            runId: run.runId,
            customerId: run.customerId,
            projectId: run.projectId,
            status: "expired",
            endedAt: now,
          })
          summary = closed.summary
          closedRun = closed.run
        } catch (error) {
          if (error instanceof RunCapturesPendingError) {
            continue
          }
          throw error
        }
      } else {
        summary = this.toSummary(run)
        closedRun = run
      }

      try {
        await this.persistExpiredRunSummary(closedRun, summary)
        await this.markExpiredRunSummaryPersisted(closedRun)
      } catch (_error) {
        hasPersistenceFailures = true
      }
    }

    // Reschedule for the earliest outstanding capture retry or run expiration.
    const remaining = await this.db.query.runCaptureIntents.findMany({
      where: sql`${schema.runCaptureIntents.status} IN ('pending', 'failed') AND ${schema.runCaptureIntents.attemptCount} < 5`,
    })
    const nextCaptureAlarmAt = remaining.length > 0 ? now + 30_000 : null
    const nextPersistenceRetryAlarmAt = hasPersistenceFailures ? now + 30_000 : null
    const nextExpirationAlarmAt = await this.findNextExpirationAlarmAt(now)
    const nextAlarmAt = [nextCaptureAlarmAt, nextPersistenceRetryAlarmAt, nextExpirationAlarmAt]
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

    await this.db
      .update(schema.runState)
      .set({
        status: input.status,
        endedAt: input.endedAt,
      })
      .where(eq(schema.runState.runId, input.runId))

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

  private async persistExpiredRunSummary(
    run: RunStateRow,
    summary: RunBudgetSummary
  ): Promise<void> {
    const { createConnection, eq: eqOp, and: andOp } = await import("@unprice/db")
    const { budgetRuns } = await import("@unprice/db/schema")

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
    })

    const updatedRows = await db
      .update(budgetRuns)
      .set({
        status: "expired",
        consumedAmount: summary.consumedAmount,
        remainingAmount: summary.remainingAmount,
        endedAt: new Date(run.endedAt ?? Date.now()),
        updatedAt: new Date(),
      })
      .where(andOp(eqOp(budgetRuns.id, run.runId), eqOp(budgetRuns.projectId, run.projectId)))
      .returning({ id: budgetRuns.id })

    if (updatedRows.length === 0) {
      throw new Error("BUDGET_RUN_NOT_FOUND")
    }
  }

  private async findExpiredRunsNeedingSummaryPersistence(now: number): Promise<RunStateRow[]> {
    return this.db.query.runState.findMany({
      where: sql`(
        ${schema.runState.status} = 'running'
        AND ${schema.runState.expiresAt} IS NOT NULL
        AND ${schema.runState.expiresAt} <= ${now}
      ) OR (
        ${schema.runState.status} = 'expired'
        AND ${schema.runState.endedAt} IS NOT NULL
        AND ${schema.runState.expiresAt} IS NOT NULL
        AND ${schema.runState.expiresAt} <= ${now}
      )`,
    })
  }

  private async markExpiredRunSummaryPersisted(run: RunStateRow): Promise<void> {
    await this.db
      .update(schema.runState)
      .set({
        expiresAt: null,
      })
      .where(eq(schema.runState.runId, run.runId))
  }

  private async hasUnresolvedCaptureIntents(runId: string): Promise<boolean> {
    const intents = await this.db.query.runCaptureIntents.findMany({
      where: sql`${schema.runCaptureIntents.status} IN ('pending', 'failed')`,
    })

    return intents.some(
      (intent) => intent.runId === runId || intent.intentKey.startsWith(`run-capture:${runId}:`)
    )
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
    const { createConnection } = await import("@unprice/db")
    const { WalletService } = await import("@unprice/services/wallet")
    const { LedgerGateway } = await import("@unprice/services/ledger")

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
    })

    const { createDoLogger } = await import("~/observability")
    const logger = createDoLogger(this.ctx.id.toString())

    const ledger = new LedgerGateway({ db, logger })
    const wallet = new WalletService({ db, logger, ledgerGateway: ledger })

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

  private async callEntitlementWindow(input: ApplyRunSyncEventInput, remainingAmount: number) {
    // Address the EntitlementWindowDO using the same naming scheme as the normal ingestion path:
    // ${appEnv}:${projectId}:${customerId}:${customerEntitlementId}
    const entitlementWindowId = this.runtimeEnv.entitlementwindow.idFromName(
      `${this.runtimeEnv.APP_ENV}:${input.projectId}:${input.customerId}:${input.customerEntitlementId}`
    )
    const entitlementWindow = this.runtimeEnv.entitlementwindow.get(entitlementWindowId)

    // The entitlement and grants are validated upstream by the use case and pass through
    // the DO contract as opaque objects. The EntitlementWindowDO re-parses them with its
    // own applyInputSchema, so the runtime data is correct even though the DO contract
    // uses looser types for these pass-through fields.
    return entitlementWindow.apply({
      event: { ...input.event, source: input.source },
      idempotencyKey: `${input.idempotencyKey}:ew`,
      projectId: input.projectId,
      customerId: input.customerId,
      entitlement: input.entitlement as Parameters<
        typeof entitlementWindow.apply
      >[0]["entitlement"],
      grants: input.grants as Parameters<typeof entitlementWindow.apply>[0]["grants"],
      enforceLimit: true,
      now: input.now,
      walletMode: "external_reservation",
      externalReservation: { remainingAmount },
    })
  }

  private async captureToWallet(input: {
    reservationId: string
    projectId: string
    customerId: string
    currency: string
    amount: number
    statementKey: string
    idempotencyKey: string
    flushSeq: number
  }): Promise<void> {
    const { createConnection } = await import("@unprice/db")
    const { WalletService } = await import("@unprice/services/wallet")
    const { LedgerGateway } = await import("@unprice/services/ledger")

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
    })

    const { createDoLogger } = await import("~/observability")
    const logger = createDoLogger(this.ctx.id.toString())
    const ledger = new LedgerGateway({ db, logger })
    const wallet = new WalletService({ db, logger, ledgerGateway: ledger })

    const result = await wallet.captureReservationUsage({
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency as "USD" | "EUR",
      reservationId: input.reservationId,
      flushSeq: input.flushSeq,
      amount: input.amount,
      statementKey: input.statementKey,
      kind: "budget_run_capture",
      metadata: { idempotency_key: input.idempotencyKey },
      sourceId: input.idempotencyKey,
    })

    if (result.err) throw result.err
  }

  private async releaseReservation(run: RunStateRow): Promise<void> {
    const { createConnection } = await import("@unprice/db")
    const { WalletService } = await import("@unprice/services/wallet")
    const { LedgerGateway } = await import("@unprice/services/ledger")

    const db = createConnection({
      env: this.runtimeEnv.APP_ENV,
      primaryDatabaseUrl: this.runtimeEnv.DATABASE_URL,
      read1DatabaseUrl: this.runtimeEnv.DATABASE_READ1_URL,
      read2DatabaseUrl: this.runtimeEnv.DATABASE_READ2_URL,
      logger: false,
    })

    const { createDoLogger } = await import("~/observability")
    const logger = createDoLogger(this.ctx.id.toString())
    const ledger = new LedgerGateway({ db, logger })
    const wallet = new WalletService({ db, logger, ledgerGateway: ledger })

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
    meterFacts: Record<string, unknown>[]
  ): Array<{
    bucketKey: string
    entitlementId: string
    featureId: string | null
    statementKey: string
    periodStartAt: number
    periodEndAt: number
    currency: string
    amount: number
  }> {
    return meterFacts.map((fact: Record<string, unknown>) => {
      const bucketKey = [
        runId,
        (fact.customer_entitlement_id as string) ?? "unknown",
        (fact.statement_key as string) ?? "unknown",
        (fact.period_key as string) ?? "unknown",
      ].join(":")

      return {
        bucketKey,
        entitlementId: (fact.customer_entitlement_id as string) ?? "unknown",
        featureId: (fact.feature_id as string) ?? null,
        statementKey: (fact.statement_key as string) ?? "unknown",
        periodStartAt: (fact.period_start_at as number) ?? 0,
        periodEndAt: (fact.period_end_at as number) ?? 0,
        currency: (fact.currency as string) ?? "USD",
        amount: (fact.amount as number) ?? 0,
      }
    })
  }

  private async commitSpend(
    run: RunStateRow,
    pricedAmount: number,
    bucketDeltas: Array<{
      bucketKey: string
      entitlementId: string
      featureId: string | null
      statementKey: string
      periodStartAt: number
      periodEndAt: number
      currency: string
      amount: number
    }>,
    now: number
  ): Promise<RunStateRow> {
    // Update run consumed amount
    const newConsumed = run.consumedAmount + pricedAmount
    await this.db
      .update(schema.runState)
      .set({
        consumedAmount: newConsumed,
        lastEventAt: now,
      })
      .where(eq(schema.runState.runId, run.runId))

    // Upsert spend buckets
    for (const delta of bucketDeltas) {
      await this.db
        .insert(schema.runSpendBuckets)
        .values({
          bucketKey: delta.bucketKey,
          runId: run.runId,
          entitlementId: delta.entitlementId,
          featureId: delta.featureId,
          statementKey: delta.statementKey,
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

    return { ...run, consumedAmount: newConsumed, lastEventAt: now }
  }

  private async persistIdempotency(
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: unknown[]
  ): Promise<void> {
    await this.db
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
      budgetAmount: run.budgetAmount,
      consumedAmount: run.consumedAmount,
      remainingAmount: Math.max(0, run.budgetAmount - run.consumedAmount),
      walletReservationId: run.reservationId ?? null,
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
