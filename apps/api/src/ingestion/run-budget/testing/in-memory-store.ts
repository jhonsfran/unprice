import {
  CAPTURE_ABANDONED_STATUS,
  CAPTURE_RETRY_STATUSES,
  CAPTURE_SUCCESS_STATUS,
  type CaptureFailureStatus,
} from "../capture-policy"
import { captureIntentFlushSeq, captureIntentRange } from "../capture-range"
import type { EndRunInput, RunBudgetDecision } from "../contracts"
import type {
  RunBudgetStore,
  RunCaptureIntent,
  RunIdempotencyEntry,
  RunSpendBucket,
  RunSpendBucketDelta,
  RunState,
} from "../ports"

export class InMemoryRunBudgetStore implements RunBudgetStore {
  readonly runs = new Map<string, RunState>()
  readonly buckets = new Map<string, RunSpendBucket>()
  readonly intents = new Map<string, RunCaptureIntent>()
  readonly idempotency = new Map<string, RunIdempotencyEntry>()
  failNextIdempotencyWrite = false
  failNextCaptureSuccessAfterBucketWrite = false

  async loadRun(runId: string) {
    return this.clone(this.runs.get(runId))
  }

  async createRun(run: RunState): Promise<void> {
    this.runs.set(run.runId, this.clone(run))
  }

  async loadIdempotency(idempotencyKey: string) {
    return this.clone(this.idempotency.get(idempotencyKey))
  }

  async persistIdempotency(
    idempotencyKey: string,
    runId: string,
    decision: RunBudgetDecision,
    pricedAmount: number,
    bucketDeltas: RunSpendBucketDelta[],
    createdAt: number
  ): Promise<void> {
    this.writeIdempotency({
      idempotencyKey,
      runId,
      decisionJson: JSON.stringify(decision),
      pricedAmount,
      bucketDeltasJson: JSON.stringify(bucketDeltas),
      createdAt,
    })
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
    const snapshot = this.snapshot()
    try {
      this.runs.set(input.run.runId, this.clone(input.updatedRun))
      for (const delta of input.bucketDeltas) {
        const existing = this.buckets.get(delta.bucketKey)
        if (existing) {
          existing.consumedAmount += delta.amount
          existing.pendingAmount += delta.amount
        } else {
          this.buckets.set(delta.bucketKey, {
            ...delta,
            runId: input.run.runId,
            consumedAmount: delta.amount,
            flushedAmount: 0,
            pendingAmount: delta.amount,
          })
        }
      }
      this.writeIdempotency({
        idempotencyKey: input.idempotencyKey,
        runId: input.run.runId,
        decisionJson: JSON.stringify(input.decision),
        pricedAmount: input.pricedAmount,
        bucketDeltasJson: JSON.stringify(input.bucketDeltas),
        createdAt: input.createdAt,
      })
    } catch (error) {
      this.restore(snapshot)
      throw error
    }
  }

  async listUnflushedBuckets() {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.consumedAmount > bucket.flushedAmount)
      .map((bucket) => this.clone(bucket))
  }

  async loadCaptureIntent(intentKey: string) {
    return this.clone(this.intents.get(intentKey))
  }

  async openCaptureIntent(input: {
    runId: string
    bucketKey: string
    now: number
  }): Promise<RunCaptureIntent | null> {
    const existing = [...this.intents.values()]
      .filter(
        (intent) =>
          intent.bucketKey === input.bucketKey &&
          CAPTURE_RETRY_STATUSES.some((status) => status === intent.status)
      )
      .sort((left, right) => captureIntentFlushSeq(left) - captureIntentFlushSeq(right))[0]
    if (existing) return this.clone(existing)

    const snapshot = this.snapshot()
    try {
      const bucket = this.buckets.get(input.bucketKey)
      const run = this.runs.get(input.runId)
      if (!bucket || !run) throw new Error("Run capture state missing")

      const bucketIntents = [...this.intents.values()].filter(
        (intent) => intent.bucketKey === input.bucketKey
      )
      const rangeStartAmount = this.captureCursor(bucket.flushedAmount, bucketIntents)
      if (bucket.consumedAmount <= rangeStartAmount) return null

      const highestIntentSeq = [...this.intents.values()].reduce(
        (highest, intent) =>
          intent.runId === input.runId ? Math.max(highest, captureIntentFlushSeq(intent)) : highest,
        0
      )
      const flushSeq = Math.max(input.now, run.lastCaptureSeq + 1, highestIntentSeq + 1)
      const targetAmount = bucket.consumedAmount
      const intent: RunCaptureIntent = {
        intentKey: `run-capture:${input.runId}:${input.bucketKey}:${rangeStartAmount}`,
        runId: input.runId,
        bucketKey: input.bucketKey,
        amount: targetAmount - rangeStartAmount,
        flushSeq,
        rangeStartAmount,
        targetAmount,
        status: "pending",
        attemptCount: 0,
        lastError: null,
        createdAt: flushSeq,
        updatedAt: input.now,
      }
      run.lastCaptureSeq = flushSeq
      this.intents.set(intent.intentKey, this.clone(intent))
      return this.clone(intent)
    } catch (error) {
      this.restore(snapshot)
      throw error
    }
  }

  async commitCaptureSuccess(input: {
    intentKey: string
    bucketKey: string
    runId: string
    amount: number
    updatedAt: number
  }): Promise<void> {
    const snapshot = this.snapshot()
    try {
      const intent = this.intents.get(input.intentKey)
      const bucket = this.buckets.get(input.bucketKey)
      const run = this.runs.get(input.runId)
      if (intent) {
        Object.assign(intent, { status: CAPTURE_SUCCESS_STATUS, updatedAt: input.updatedAt })
      }
      if (bucket) bucket.flushedAmount += input.amount
      if (this.failNextCaptureSuccessAfterBucketWrite) {
        this.failNextCaptureSuccessAfterBucketWrite = false
        throw new Error("capture success failed after bucket write")
      }
      if (run) run.flushedAmount += input.amount
    } catch (error) {
      this.restore(snapshot)
      throw error
    }
  }

  async markCaptureFailure(input: {
    intentKey: string
    status: CaptureFailureStatus
    attemptCount: number
    lastError: string
    updatedAt: number
  }): Promise<void> {
    const intent = this.intents.get(input.intentKey)
    if (intent) Object.assign(intent, input)
  }

  async listRetryableCaptureIntents() {
    return [...this.intents.values()]
      .filter((intent) => CAPTURE_RETRY_STATUSES.some((status) => status === intent.status))
      .map((intent) => this.clone(intent))
  }

  async hasUnresolvedCaptureIntents(runId: string): Promise<boolean> {
    return (await this.listRetryableCaptureIntents()).some((intent) =>
      this.intentBelongsToRun(intent, runId)
    )
  }

  async hasCaptureableSpend(runId: string): Promise<boolean> {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.runId === runId)
      .some((bucket) => {
        const bucketIntents = [...this.intents.values()].filter(
          (intent) => intent.bucketKey === bucket.bucketKey
        )
        const hasRetryable = bucketIntents.some((intent) =>
          CAPTURE_RETRY_STATUSES.some((status) => status === intent.status)
        )
        return (
          hasRetryable ||
          bucket.consumedAmount > this.captureCursor(bucket.flushedAmount, bucketIntents)
        )
      })
  }

  async findAbandonedCaptureIntents(runId: string) {
    return [...this.intents.values()]
      .filter(
        (intent) =>
          intent.status === CAPTURE_ABANDONED_STATUS && this.intentBelongsToRun(intent, runId)
      )
      .map((intent) => this.clone(intent))
  }

  async findRunningRunsPastExpiry(now: number) {
    return [...this.runs.values()]
      .filter((run) => run.status === "running" && run.expiresAt !== null && run.expiresAt <= now)
      .map((run) => this.clone(run))
  }

  async findNextExpirationAlarmAt(now: number): Promise<number | null> {
    return [...this.runs.values()].reduce<number | null>((next, run) => {
      if (run.status !== "running" || run.expiresAt === null || run.expiresAt <= now) return next
      return next === null || run.expiresAt < next ? run.expiresAt : next
    }, null)
  }

  async closeRun(input: {
    runId: string
    status: EndRunInput["status"]
    endedAt: number
    reconciliationNeeded: boolean
  }): Promise<void> {
    const run = this.runs.get(input.runId)
    if (run) Object.assign(run, input)
  }

  async markExpiredRunFinalized(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (run) run.expiresAt = null
  }

  private writeIdempotency(entry: RunIdempotencyEntry): void {
    if (this.failNextIdempotencyWrite) {
      this.failNextIdempotencyWrite = false
      throw new Error("run idempotency insert failed")
    }
    if (!this.idempotency.has(entry.idempotencyKey)) {
      this.idempotency.set(entry.idempotencyKey, this.clone(entry))
    }
  }

  private intentBelongsToRun(intent: RunCaptureIntent, runId: string): boolean {
    return intent.runId === runId || intent.intentKey.startsWith(`run-capture:${runId}:`)
  }

  private captureCursor(flushedAmount: number, intents: RunCaptureIntent[]): number {
    return intents.reduce((cursor, intent) => {
      if (intent.status !== CAPTURE_SUCCESS_STATUS && intent.status !== CAPTURE_ABANDONED_STATUS) {
        return cursor
      }
      return Math.max(cursor, captureIntentRange(intent).targetAmount)
    }, flushedAmount)
  }

  private snapshot() {
    return {
      runs: this.cloneMap(this.runs),
      buckets: this.cloneMap(this.buckets),
      intents: this.cloneMap(this.intents),
      idempotency: this.cloneMap(this.idempotency),
    }
  }

  private restore(snapshot: ReturnType<InMemoryRunBudgetStore["snapshot"]>): void {
    this.replaceMap(this.runs, snapshot.runs)
    this.replaceMap(this.buckets, snapshot.buckets)
    this.replaceMap(this.intents, snapshot.intents)
    this.replaceMap(this.idempotency, snapshot.idempotency)
  }

  private cloneMap<T>(source: Map<string, T>): Map<string, T> {
    return new Map([...source].map(([key, value]) => [key, this.clone(value)]))
  }

  private replaceMap<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear()
    for (const [key, value] of source) target.set(key, this.clone(value))
  }

  private clone<T>(value: T): T {
    return structuredClone(value)
  }
}
