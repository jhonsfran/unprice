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
    if (existing) return this.toSummary(existing)

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
      agentId: input.agentId ?? "",
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
      return JSON.parse(cached.decisionJson) as RunBudgetDecision
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
      }
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
      }
      await this.persistIdempotency(input.idempotencyKey, input.runId, decision, 0, [])
      return decision
    }

    // Derive priced cost from meter facts
    const pricedAmount = this.sumPricedAmount(entitlementResult.meterFacts ?? [])
    const bucketDeltas = this.deriveBucketDeltas(input.runId, entitlementResult.meterFacts ?? [])

    // Update run spend and buckets in one transaction
    const updatedRun = await this.commitSpend(run, pricedAmount, bucketDeltas, input.now)

    const decision: RunBudgetDecision = {
      allowed: true,
      state: "processed",
      budget: this.toSummary(updatedRun),
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

    const run = await this.loadRun(input.runId)
    if (!run) throw new Error("RUN_NOT_FOUND")

    // Final flush of all pending captures
    await this.flushCaptures()

    // Reload state after flush
    const afterFlush = await this.loadRun(input.runId)
    if (!afterFlush) throw new Error("Run state missing after flush")

    // Release unused reservation funds
    if (afterFlush.reservationId) {
      await this.releaseReservation(afterFlush)
    }

    // Update status
    await this.db
      .update(schema.runState)
      .set({
        status: input.status,
        endedAt: input.endedAt,
      })
      .where(eq(schema.runState.runId, input.runId))

    const final = await this.loadRun(input.runId)
    if (!final) throw new Error("Run state missing after endRun")
    return this.toSummary(final)
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

      // Persist capture intent before external I/O
      await this.db
        .insert(schema.runCaptureIntents)
        .values({
          intentKey,
          runId: bucket.runId,
          bucketKey: bucket.bucketKey,
          amount: pendingAmount,
          status: "pending",
          attemptCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.runCaptureIntents.intentKey,
          set: {
            amount: pendingAmount,
            status: "pending",
            updatedAt: Date.now(),
          },
        })

      try {
        // External wallet capture
        await this.captureToWallet({
          reservationId: run.reservationId,
          projectId: run.projectId,
          customerId: run.customerId,
          currency: run.currency,
          amount: pendingAmount,
          statementKey: bucket.statementKey,
          idempotencyKey: intentKey,
        })

        // Mark intent as captured and update bucket flushed amount
        await this.db
          .update(schema.runCaptureIntents)
          .set({ status: "captured", updatedAt: Date.now() })
          .where(eq(schema.runCaptureIntents.intentKey, intentKey))

        await this.db
          .update(schema.runSpendBuckets)
          .set({ flushedAmount: bucket.consumedAmount })
          .where(eq(schema.runSpendBuckets.bucketKey, bucket.bucketKey))

        // Update run-level flushed amount
        await this.db
          .update(schema.runState)
          .set({
            flushedAmount: sql`${schema.runState.flushedAmount} + ${pendingAmount}`,
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

    // Expire runs past their expiry time
    const now = Date.now()
    const expiredRuns = await this.db.query.runState.findMany({
      where: sql`${schema.runState.status} = 'running' AND ${schema.runState.expiresAt} IS NOT NULL AND ${schema.runState.expiresAt} <= ${now}`,
    })

    for (const run of expiredRuns) {
      await this.endRun({
        runId: run.runId,
        customerId: run.customerId,
        projectId: run.projectId,
        status: "expired",
        endedAt: now,
      })
    }

    // Reschedule if there are still pending intents
    const remaining = await this.db.query.runCaptureIntents.findMany({
      where: sql`${schema.runCaptureIntents.status} IN ('pending', 'failed') AND ${schema.runCaptureIntents.attemptCount} < 5`,
    })
    if (remaining.length > 0) {
      await this.scheduleAlarm(30_000) // Retry in 30s
    }
  }

  // --- Private methods ---

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
        agent_id: input.agentId,
        run_id: input.runId,
        trace_id: input.traceId ?? null,
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
      entitlement: input.entitlement as Parameters<typeof entitlementWindow.apply>[0]["entitlement"],
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
      flushSeq: Date.now(), // Use timestamp as monotonic seq for run captures
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
      idempotencyKey: `release:${run.runId}:${Date.now()}`,
      metadata: { agent_id: run.agentId, run_id: run.runId },
    })

    if (result.err) throw result.err
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
    const currentAlarm = await this.ctx.storage.getAlarm()
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + delayMs)
    }
  }
}
