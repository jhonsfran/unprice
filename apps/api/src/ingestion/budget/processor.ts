import {
  type BudgetCommand,
  type BudgetInspectQuery,
  type BudgetInspectReply,
  type BudgetReply,
  UnPriceBudgetError,
  deletableAt,
  inspect,
  isOutcomeOf,
  loadView,
  transition,
} from "@unprice/services/budgets"
import type { CardRows } from "@unprice/services/pricing"
import type { BudgetRequest } from "@unprice/services/use-cases"
import { JOURNAL_BATCH, journalRowOf } from "./journal"
import type { BudgetProcessorDeps, BudgetStoreTx } from "./ports"

export const ALARM_PURGE_LIMIT = 2048
export const ALARM_CONTINUE_MS = 1_000
export const ALARM_RETRY_MS = 30_000
/**
 * How often a closed budget checks unfinished statements and wallet reservations before deletion.
 */
export const UNFINISHED_BILLING_RECHECK_MS = 24 * 60 * 60_000
/** How long written rows wait for the alarm that exports them, so one send carries many. */
export const JOURNAL_EXPORT_DELAY_MS = 10_000
/** The most journal batches one alarm sends; the alarm comes back for the rest. */
export const JOURNAL_BATCHES_PER_ALARM = 4

/** A command's reply, and the alarm its written rows need: a refused lease is written too. */
type Committed = { reply: BudgetReply; wakeAt: number | null; now: number; wrote: boolean }

/** How an alarm's export went: everything sent, more left to send, or a failed send. */
type Exported = "done" | "more" | "failed"

/**
 * What the alarm does after its export: wake again (or never), or delete the closed budget.
 * `unexported`: rows the journal has yet to receive remain.
 */
type Swept = { destroy: true } | { destroy: false; next: number | null; unexported: boolean }

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
    const now = this.deps.clock.now()
    await this.lowerAlarm(
      this.deps.store.atomically((tx) => {
        const budget = tx.readBudget()
        // Rows an eviction left unexported wake the alarm that sends them.
        const unexported = tx.readUnexported(1).length > 0 ? this.exportAt(now) : null
        return earliest(earliest(tx.nextDueAt(), budget && deletableAt(budget.config)), unexported)
      })
    )
  }

  async execute(request: BudgetRequest, cards?: readonly CardRows[]): Promise<BudgetReply> {
    const clockMs = this.deps.clock.now()
    let committed: Committed
    try {
      committed = this.deps.store.atomically((tx) => {
        if (cards) tx.cacheCards(cards, clockMs)
        const result = commit(tx, request, clockMs)
        if (cards && !result.reply.ok && result.reply.rejection.code === "CARDS_STALE") {
          // An incomplete refresh must roll back its cache writes with the refused command.
          throw new UnPriceBudgetError(result.reply.rejection)
        }
        return result
      })
    } catch (error) {
      if (error instanceof UnPriceBudgetError && error.rejection.code === "CARDS_STALE") {
        return { ok: false, rejection: error.rejection }
      }
      throw error
    }
    const { reply, wakeAt, wrote, now } = committed
    await this.lowerAlarm(earliest(wakeAt, wrote ? this.exportAt(now) : null))
    return reply
  }

  /** When written rows reach the journal: after the batching delay, or never without a stream. */
  private exportAt(now: number): number | null {
    return this.deps.journal ? now + JOURNAL_EXPORT_DELAY_MS : null
  }

  /**
   * Sends unexported rows in order and advances the cursor after each send. The send awaits
   * outside any transaction: a command may write meanwhile, and its rows take later `seq`s.
   */
  private async exportJournal(): Promise<Exported> {
    const { journal, store } = this.deps
    if (!journal) return "done"
    try {
      for (let batch = 0; batch < JOURNAL_BATCHES_PER_ALARM; batch++) {
        const pending = store.atomically((tx) => {
          const budget = tx.readBudget()
          if (!budget) return []
          const entries = tx.readUnexported(JOURNAL_BATCH)
          return entries.map((entry) => ({ entry, row: journalRowOf(budget, entry) }))
        })
        const last = pending[pending.length - 1]
        if (!last) return "done"
        await journal.send(pending.map(({ row }) => row))
        store.atomically((tx) => tx.markExported(last.entry.seq))
        if (pending.length < JOURNAL_BATCH) return "done"
      }
      return "more"
    } catch (error) {
      this.deps.logger.error("budget journal export failed", { error: errorMessage(error) })
      return "failed"
    }
  }

  /** Whether the storage holds a budget, as opposed to a schema a refused first call left. */
  hasBudget(): boolean {
    return this.deps.store.atomically((tx) => tx.readBudget() !== null)
  }

  /**
   * Answers `get` through the same commit, so it writes only when a window rolled, then reads the
   * inspection in that transaction at the clock the get clamped to.
   */
  async inspect(query: BudgetInspectQuery): Promise<BudgetInspectReply> {
    const clockMs = this.deps.clock.now()
    const { reply, wakeAt } = this.deps.store.inspecting(
      (tx): { reply: BudgetInspectReply; wakeAt: number | null } => {
        const got = commit(tx, { type: "get" }, clockMs)
        if (!got.reply.ok) return { reply: got.reply, wakeAt: got.wakeAt }
        if (!isOutcomeOf(got.reply.outcome, "get")) throw new Error("get answered another verb")
        const inspection = inspect(tx, got.reply.outcome, query, got.now)
        return { reply: { ok: true, inspection }, wakeAt: got.wakeAt }
      }
    )
    await this.lowerAlarm(wakeAt)
    return reply
  }

  async alarm(): Promise<void> {
    this.armedAt = null
    this.pendingAt = null
    const now = this.deps.clock.now()
    let next: number | null
    try {
      // The sweep's rows go out with this alarm's export, and the purge after it drops what the
      // export sent.
      const sweptAt = this.deps.store.atomically((tx) => sweep(tx, now))
      const exported = await this.exportJournal()
      const swept = this.deps.store.atomically((tx) => afterExport(tx, sweptAt))
      if (swept.destroy) {
        await this.deps.runtime.destroy()
        return
      }
      const exportNext = {
        done: swept.unexported ? this.exportAt(now) : null,
        more: now + ALARM_CONTINUE_MS,
        failed: now + ALARM_RETRY_MS,
      }[exported]
      next = earliest(swept.next, exportNext)
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
  // Nothing was written. Only the sweep reads `now`, and a sweep is never rejected.
  if (result.err) {
    const reply: BudgetReply = { ok: false, rejection: result.err.rejection }
    return { reply, wakeAt: null, now: clockMs, wrote: false }
  }

  const { write, now, wakeAt } = result.val
  if (write) tx.commit(result.val)
  const reply: BudgetReply = result.val.ok
    ? { ok: true, outcome: result.val.outcome }
    : { ok: false, rejection: result.val.rejection }
  const wrote = write && result.val.operations.length > 0
  return { reply, wakeAt: write ? wakeAt : null, now, wrote }
}

/** Settles expired reservations. Returns the clock the sweep moved the budget to, or null. */
function sweep(tx: BudgetStoreTx, clockMs: number): number | null {
  if (tx.readBudget() === null) return null
  const swept = commit(tx, { type: "sweep" }, clockMs)
  if (!swept.reply.ok) throw new Error(`budget sweep rejected: ${swept.reply.rejection.code}`)
  return swept.now
}

/**
 * Purges exported closed rows. Returns the next wake, null for none, or that a budget closed for
 * CLOSED_BUDGET_RETENTION_MS with no row left can delete its storage.
 */
function afterExport(tx: BudgetStoreTx, sweptAt: number | null): Swept {
  const budget = tx.readBudget()
  if (budget === null || sweptAt === null) return { destroy: false, next: null, unexported: false }
  // The sweep moved the budget's clock to `sweptAt`, so purging at it never runs ahead of a command.
  tx.purgeOperations(sweptAt, ALARM_PURGE_LIMIT)
  const due = tx.nextDueAt()
  const deletable = deletableAt(budget.config)
  // A row the journal has not received keeps the storage: deleting it would lose the row.
  const unexported = tx.readUnexported(1).length > 0
  if (due === null && !unexported && deletable !== null && sweptAt >= deletable) {
    if (!tx.hasOpenFunding() && !tx.hasUnfinishedStatements()) return { destroy: true }
    return { destroy: false, next: sweptAt + UNFINISHED_BILLING_RECHECK_MS, unexported }
  }
  // Work a capped batch left behind is already due, so the floor is also the continuation delay,
  // and it keeps a row the sweep cannot clear from spinning the alarm. A deletion already due
  // waits for the rows instead.
  const rows = due === null ? null : Math.max(due, sweptAt + ALARM_CONTINUE_MS)
  return {
    destroy: false,
    next: earliest(rows, deletable !== null && deletable > sweptAt ? deletable : null),
    unexported,
  }
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  return b === null ? a : Math.min(a, b)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
