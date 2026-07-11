import { eq, inArray, sql } from "drizzle-orm"
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite"
import {
  CAPTURE_ABANDONED_STATUS,
  CAPTURE_RETRY_STATUSES,
  CAPTURE_SUCCESS_STATUS,
  type CaptureFailureStatus,
  runCaptureStatusSchema,
} from "./capture-policy"
import { type EndRunInput, type RunBudgetDecision, runStatusSchema } from "./contracts"
import * as schema from "./db/schema"
import type {
  RunBudgetStore as RunBudgetStateStore,
  RunCaptureIntent,
  RunSpendBucketDelta,
  RunState,
} from "./ports"

type SqliteHandle = DrizzleSqliteDODatabase<typeof schema>
type DbWriter = Pick<SqliteHandle, "insert" | "update">

export class RunBudgetStore implements RunBudgetStateStore {
  constructor(private readonly db: SqliteHandle) {}

  async loadRun(runId: string) {
    const row = await this.db.query.runState.findFirst({ where: eq(schema.runState.runId, runId) })
    return row ? this.toRunState(row) : undefined
  }

  async createRun(run: RunState): Promise<void> {
    await this.db.insert(schema.runState).values(run)
  }

  async loadIdempotency(idempotencyKey: string) {
    return this.db.query.runIdempotency.findFirst({
      where: eq(schema.runIdempotency.idempotencyKey, idempotencyKey),
    })
  }

  async persistIdempotency(
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[],
    createdAt: number
  ): Promise<void> {
    this.writeIdempotency(
      this.db,
      idempotencyKey,
      runId,
      decision,
      pricedAmount,
      bucketDeltas,
      createdAt
    )
  }

  async commitSpendAndIdempotency(input: {
    run: RunState
    updatedRun: RunState
    idempotencyKey: string
    decision: RunBudgetDecision
    pricedAmount: number
    bucketDeltas: RunSpendBucketDelta[]
    createdAt: number
  }): Promise<void> {
    this.db.transaction((tx) => {
      this.persistSpend(tx, input.run, input.updatedRun, input.bucketDeltas)
      this.writeIdempotency(
        tx,
        input.idempotencyKey,
        input.run.runId,
        input.decision,
        input.pricedAmount,
        input.bucketDeltas,
        input.createdAt
      )
    })
  }

  async listUnflushedBuckets() {
    return this.db.query.runSpendBuckets.findMany({
      where: sql`${schema.runSpendBuckets.consumedAmount} > ${schema.runSpendBuckets.flushedAmount}`,
    })
  }

  async loadCaptureIntent(intentKey: string) {
    const row = await this.db.query.runCaptureIntents.findFirst({
      where: eq(schema.runCaptureIntents.intentKey, intentKey),
    })
    return row ? this.toCaptureIntent(row) : undefined
  }

  async upsertCaptureIntent(intent: RunCaptureIntent): Promise<void> {
    await this.db
      .insert(schema.runCaptureIntents)
      .values(intent)
      .onConflictDoUpdate({
        target: schema.runCaptureIntents.intentKey,
        set: { status: "pending", updatedAt: intent.updatedAt },
      })
  }

  async commitCaptureSuccess(input: {
    intentKey: string
    bucketKey: string
    runId: string
    amount: number
    updatedAt: number
  }): Promise<void> {
    this.db.transaction((tx) => {
      tx.update(schema.runCaptureIntents)
        .set({ status: CAPTURE_SUCCESS_STATUS, updatedAt: input.updatedAt })
        .where(eq(schema.runCaptureIntents.intentKey, input.intentKey))
        .run()
      tx.update(schema.runSpendBuckets)
        .set({
          flushedAmount: sql`${schema.runSpendBuckets.flushedAmount} + ${input.amount}`,
        })
        .where(eq(schema.runSpendBuckets.bucketKey, input.bucketKey))
        .run()
      tx.update(schema.runState)
        .set({ flushedAmount: sql`${schema.runState.flushedAmount} + ${input.amount}` })
        .where(eq(schema.runState.runId, input.runId))
        .run()
    })
  }

  async markCaptureFailure(input: {
    intentKey: string
    status: CaptureFailureStatus
    attemptCount: number
    lastError: string
    updatedAt: number
  }): Promise<void> {
    await this.db
      .update(schema.runCaptureIntents)
      .set({
        status: input.status,
        attemptCount: input.attemptCount,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      })
      .where(eq(schema.runCaptureIntents.intentKey, input.intentKey))
  }

  async listRetryableCaptureIntents() {
    const rows = await this.db.query.runCaptureIntents.findMany({
      where: inArray(schema.runCaptureIntents.status, [...CAPTURE_RETRY_STATUSES]),
    })
    return rows.map((row) => this.toCaptureIntent(row))
  }

  async hasUnresolvedCaptureIntents(runId: string): Promise<boolean> {
    const intents = await this.listRetryableCaptureIntents()
    return intents.some((intent) => this.intentBelongsToRun(intent, runId))
  }

  async findAbandonedCaptureIntents(runId: string) {
    const rows = await this.db.query.runCaptureIntents.findMany({
      where: eq(schema.runCaptureIntents.status, CAPTURE_ABANDONED_STATUS),
    })
    const intents = rows.map((row) => this.toCaptureIntent(row))
    return intents.filter((intent) => this.intentBelongsToRun(intent, runId))
  }

  async findRunningRunsPastExpiry(now: number) {
    const rows = await this.db.query.runState.findMany({
      where: sql`
        ${schema.runState.status} = 'running'
        AND ${schema.runState.expiresAt} IS NOT NULL
        AND ${schema.runState.expiresAt} <= ${now}
      `,
    })
    return rows.map((row) => this.toRunState(row))
  }

  async findNextExpirationAlarmAt(now: number): Promise<number | null> {
    const runs = await this.db.query.runState.findMany({
      where: sql`${schema.runState.status} = 'running' AND ${schema.runState.expiresAt} IS NOT NULL AND ${schema.runState.expiresAt} > ${now}`,
    })
    return runs.reduce<number | null>((next, run) => {
      if (!run.expiresAt) return next
      return next === null || run.expiresAt < next ? run.expiresAt : next
    }, null)
  }

  async closeRun(input: {
    runId: string
    status: EndRunInput["status"]
    endedAt: number
    reconciliationNeeded: boolean
  }): Promise<void> {
    await this.db
      .update(schema.runState)
      .set({
        status: input.status,
        endedAt: input.endedAt,
        reconciliationNeeded: input.reconciliationNeeded,
      })
      .where(eq(schema.runState.runId, input.runId))
  }

  async markExpiredRunFinalized(runId: string): Promise<void> {
    await this.db
      .update(schema.runState)
      .set({ expiresAt: null })
      .where(eq(schema.runState.runId, runId))
  }

  private intentBelongsToRun(intent: RunCaptureIntent, runId: string): boolean {
    return intent.runId === runId || intent.intentKey.startsWith(`run-capture:${runId}:`)
  }

  private toRunState(row: typeof schema.runState.$inferSelect): RunState {
    return { ...row, status: runStatusSchema.parse(row.status) }
  }

  private toCaptureIntent(row: typeof schema.runCaptureIntents.$inferSelect): RunCaptureIntent {
    return { ...row, status: runCaptureStatusSchema.parse(row.status) }
  }

  private persistSpend(
    db: DbWriter,
    run: RunState,
    updatedRun: RunState,
    bucketDeltas: RunSpendBucketDelta[]
  ): void {
    db.update(schema.runState)
      .set({ consumedAmount: updatedRun.consumedAmount, lastEventAt: updatedRun.lastEventAt })
      .where(eq(schema.runState.runId, run.runId))
      .run()

    for (const delta of bucketDeltas) {
      db.insert(schema.runSpendBuckets)
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
        .run()
    }
  }

  private writeIdempotency(
    db: DbWriter,
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[],
    createdAt: number
  ): void {
    db.insert(schema.runIdempotency)
      .values({
        idempotencyKey,
        runId,
        decisionJson: JSON.stringify(decision),
        pricedAmount,
        bucketDeltasJson: JSON.stringify(bucketDeltas),
        createdAt,
      })
      .onConflictDoNothing()
      .run()
  }
}
