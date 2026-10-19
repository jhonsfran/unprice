import {
  type BudgetCommand,
  type BudgetOutcome,
  type BudgetRejection,
  EXPIRED_PER_SWEEP,
  deletableAt,
  loadView,
  transition,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import type { BudgetProcessorDeps, BudgetStoreTx } from "./ports"

export const ALARM_PURGE_LIMIT = 2048
export const ALARM_CONTINUE_MS = 1_000
export const ALARM_RETRY_MS = 30_000

type Committed =
  | { ok: true; outcome: BudgetOutcome; wakeAt: number | null; now: number; written: number }
  | { ok: false; rejection: BudgetRejection }

/** What one alarm run did, for its log line. */
export type BudgetAlarmRun = Readonly<{
  /** Expired holds and leases the sweep closed. */
  expired: number
  /** Closed rows past their retention the purge deleted. */
  purged: number
  /** The sweep or the purge filled its batch, so the alarm comes straight back for the rest. */
  capped: boolean
}>

/** What the alarm does after a sweep: wake again (or never), or delete the closed budget. */
type Swept = Pick<BudgetAlarmRun, "expired" | "purged"> &
  ({ destroy: true } | { destroy: false; next: number | null })

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

  /**
   * Lowers the stored alarm to the earliest due row or deletion, even when one is armed: an eviction
   * between a commit and its `setAlarm` leaves the later alarm in place, and an expired hold would
   * otherwise stay held until that later wake.
   */
  async initialize(): Promise<void> {
    this.armedAt = await this.deps.scheduler.getAlarm()
    await this.lowerAlarm(
      this.deps.store.atomically((tx) => {
        const budget = tx.readBudget()
        return earliest(tx.nextDueAt(), budget && deletableAt(budget.config))
      })
    )
  }

  async execute(request: BudgetRequest): Promise<BudgetReply> {
    const clockMs = this.deps.clock.now()
    const committed = this.deps.store.atomically((tx) => commit(tx, request, clockMs))
    if (!committed.ok) return committed
    await this.lowerAlarm(committed.wakeAt)
    return { ok: true, outcome: committed.outcome }
  }

  async alarm(): Promise<BudgetAlarmRun> {
    this.armedAt = null
    this.pendingAt = null
    const now = this.deps.clock.now()
    let swept: Swept
    try {
      swept = this.deps.store.atomically((tx) => sweep(tx, now))
    } catch (error) {
      this.deps.logger.error("budget alarm failed", { error: errorMessage(error) })
      swept = { expired: 0, purged: 0, destroy: false, next: now + ALARM_RETRY_MS }
    }
    const { expired, purged } = swept
    const run = {
      expired,
      purged,
      capped: expired >= EXPIRED_PER_SWEEP || purged >= ALARM_PURGE_LIMIT,
    }
    if (swept.destroy) {
      await this.deps.runtime.destroy()
      return run
    }
    const { next } = swept
    if (next === null) return run
    try {
      await this.lowerAlarm(next)
    } catch (error) {
      this.deps.logger.error("budget alarm could not re-arm", { error: errorMessage(error) })
      throw error
    }
    return run
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

  const { write, outcome, now, wakeAt, operations } = result.val
  if (write) tx.commit(result.val)
  return {
    ok: true,
    outcome,
    wakeAt: write ? wakeAt : null,
    now,
    written: write ? operations.length : 0,
  }
}

/**
 * Settles expired holds and purges closed rows. Returns the next wake, null for none, or that a
 * budget closed for CLOSED_BUDGET_RETENTION_MS with no row left can delete its storage.
 */
function sweep(tx: BudgetStoreTx, clockMs: number): Swept {
  const budget = tx.readBudget()
  if (budget === null) return { expired: 0, purged: 0, destroy: false, next: null }
  const swept = commit(tx, { type: "sweep" }, clockMs)
  if (!swept.ok) throw new Error(`budget sweep rejected: ${swept.rejection.code}`)
  // A sweep writes exactly the expired reservations it closed.
  const expired = swept.written
  // The sweep moved the budget's clock to `now`, so purging at it never runs ahead of a command.
  const purged = tx.purgeOperations(swept.now, ALARM_PURGE_LIMIT)
  const due = tx.nextDueAt()
  const deletable = deletableAt(budget.config)
  if (due === null && deletable !== null && swept.now >= deletable) {
    return { expired, purged, destroy: true }
  }
  // Work a capped batch left behind is already due, so the floor is also the continuation delay,
  // and it keeps a row the sweep cannot clear from spinning the alarm. A deletion already due
  // waits for the rows instead.
  const rows = due === null ? null : Math.max(due, swept.now + ALARM_CONTINUE_MS)
  return {
    expired,
    purged,
    destroy: false,
    next: earliest(rows, deletable !== null && deletable > swept.now ? deletable : null),
  }
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  return b === null ? a : Math.min(a, b)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
