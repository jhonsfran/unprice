import {
  type BudgetCommand,
  type BudgetOutcome,
  type BudgetRejection,
  loadView,
  transition,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import type { BudgetProcessorDeps, BudgetStoreTx } from "./ports"

export const INLINE_SWEEP_LIMIT = 32
export const ALARM_SWEEP_LIMIT = 256
export const ALARM_PURGE_LIMIT = 512
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

  constructor(private readonly deps: BudgetProcessorDeps) {}

  async initialize(): Promise<void> {
    this.armedAt = await this.deps.scheduler.getAlarm()
    if (this.armedAt === null && this.deps.store.atomically((tx) => tx.readBudget()) !== null) {
      await this.lowerAlarm(this.deps.clock.now())
    }
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    const clockMs = this.deps.clock.now()
    const committed = this.deps.store.atomically((tx) =>
      commit(tx, request, clockMs, INLINE_SWEEP_LIMIT)
    )
    if (!committed.ok) return committed
    await this.lowerAlarm(committed.wakeAt)
    return { ok: true, outcome: committed.outcome }
  }

  /**
   * Sweeper: lapses due holds, rolls ended windows, purges rows whose retention ended, and re-arms
   * for the next due row. A budget with no rows due sleeps until a command writes one.
   */
  async alarm(): Promise<void> {
    this.armedAt = null
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
    }
  }

  private async lowerAlarm(at: number | null): Promise<void> {
    if (at === null || (this.armedAt !== null && this.armedAt <= at)) return
    this.armedAt = at
    try {
      await this.deps.scheduler.setAlarm(at)
    } catch (error) {
      this.armedAt = null
      throw error
    }
  }
}

function commit(
  tx: BudgetStoreTx,
  command: BudgetCommand,
  clockMs: number,
  dueLimit: number
): Committed {
  const view = loadView(tx, command, clockMs, dueLimit)
  const result = transition({ view, command, clockMs })
  if (result.err) return { ok: false, rejection: result.err.rejection }

  const { write, outcome, now, wakeAt } = result.val
  if (write) tx.commit(result.val)
  return { ok: true, outcome, wakeAt: write ? wakeAt : null, now }
}

/** Returns the next wake, or null when nothing is due. */
function sweep(tx: BudgetStoreTx, clockMs: number): number | null {
  if (tx.readBudget() === null) return null
  const swept = commit(tx, { type: "sweep" }, clockMs, ALARM_SWEEP_LIMIT)
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
