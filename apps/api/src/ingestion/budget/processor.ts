import {
  type BudgetCommand,
  type BudgetOutcome,
  type BudgetRejection,
  loadView,
  transition,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import type { BudgetProcessorDeps, BudgetStoreTx } from "./ports"

export const ALARM_PURGE_LIMIT = 2048
export const ALARM_CONTINUE_MS = 1_000
export const ALARM_RETRY_MS = 30_000

type Committed =
  | { ok: true; outcome: BudgetOutcome; wakeAt: number | null; now: number }
  | { ok: false; rejection: BudgetRejection }

/**
 * Business orchestration for one budget. Every command is one synchronous SQLite transaction
 * (read view, `transition`, write), so no request can interleave between check and debit and
 * mutations need no blockConcurrencyWhile. The only await is arming the alarm after commit.
 */
export class BudgetProcessor {
  /** The alarm this object last set. Lowered synchronously so concurrent commands never raise it. */
  private armedAt: number | null = null
  private pendingAt: number | null = null

  constructor(private readonly deps: BudgetProcessorDeps) {}

  async initialize(): Promise<void> {
    this.armedAt = await this.deps.scheduler.getAlarm()
    if (this.armedAt === null) {
      await this.lowerAlarm(this.deps.store.atomically((tx) => tx.nextDueAt()))
    }
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    const clockMs = this.deps.clock.now()
    const committed = this.deps.store.atomically((tx) => commit(tx, request, clockMs))
    if (!committed.ok) return committed
    await this.lowerAlarm(committed.wakeAt)
    return { ok: true, outcome: committed.outcome }
  }

  async alarm(): Promise<void> {
    this.armedAt = null
    this.pendingAt = null
    const now = this.deps.clock.now()
    let next: number | null
    try {
      next = this.deps.store.atomically((tx) => sweep(tx, now))
    } catch (error) {
      this.deps.logger.error("budget alarm failed", { error: errorMessage(error) })
      next = now + ALARM_RETRY_MS
    }
    if (next === null) return
    try {
      await this.lowerAlarm(next)
    } catch (error) {
      this.deps.logger.error("budget alarm could not re-arm", { error: errorMessage(error) })
      throw error
    }
  }

  private async lowerAlarm(at: number | null): Promise<void> {
    if (at !== null && (this.pendingAt === null || at < this.pendingAt)) this.pendingAt = at
    const pending = this.pendingAt
    if (pending === null) return
    if (this.armedAt !== null && this.armedAt <= pending) return
    this.armedAt = pending
    try {
      await this.deps.scheduler.setAlarm(pending)
      if (this.pendingAt === pending) this.pendingAt = null
    } catch (error) {
      if (this.armedAt === pending) this.armedAt = null
      throw error
    }
  }
}

function commit(tx: BudgetStoreTx, command: BudgetCommand, clockMs: number): Committed {
  const view = loadView(tx, command, clockMs)
  const result = transition({ view, command, clockMs })
  if (result.err) return { ok: false, rejection: result.err.rejection }

  const { write, outcome, now, wakeAt } = result.val
  if (write) tx.commit(result.val)
  return { ok: true, outcome, wakeAt: write ? wakeAt : null, now }
}

/** Settles expired holds, purges closed rows, and returns the next wake, or null for none. */
function sweep(tx: BudgetStoreTx, clockMs: number): number | null {
  if (tx.readBudget() === null) return null
  const swept = commit(tx, { type: "sweep" }, clockMs)
  if (!swept.ok) throw new Error(`budget sweep rejected: ${swept.rejection.code}`)
  // The sweep moved the budget's clock to `now`, so purging at it never runs ahead of a command.
  tx.purgeOperations(swept.now, ALARM_PURGE_LIMIT)
  const next = tx.nextDueAt()
  // Work a capped batch left behind is already due, so the floor is also the continuation delay,
  // and it keeps a row the sweep cannot clear from spinning the alarm.
  return next === null ? null : Math.max(next, swept.now + ALARM_CONTINUE_MS)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
