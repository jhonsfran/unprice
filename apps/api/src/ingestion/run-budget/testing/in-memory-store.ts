import { CAPTURE_ABANDONED_STATUS, CAPTURE_RETRY_STATUSES } from "../capture-policy"
import type { RunBudgetDecision } from "../contracts"
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
    bucketDeltas: unknown[],
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

  async upsertCaptureIntent(intent: RunCaptureIntent): Promise<void> {
    const existing = this.intents.get(intent.intentKey)
    this.intents.set(
      intent.intentKey,
      existing
        ? { ...existing, status: "pending", updatedAt: intent.updatedAt }
        : this.clone(intent)
    )
  }

  async commitCaptureSuccess(input: {
    intentKey: string
    bucketKey: string
    runId: string
    amount: number
    updatedAt: number
  }): Promise<void> {
    const intent = this.intents.get(input.intentKey)
    const bucket = this.buckets.get(input.bucketKey)
    const run = this.runs.get(input.runId)
    if (intent) Object.assign(intent, { status: "captured", updatedAt: input.updatedAt })
    if (bucket) bucket.flushedAmount += input.amount
    if (run) run.flushedAmount += input.amount
  }

  async markCaptureFailure(input: {
    intentKey: string
    status: string
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
    status: string
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
