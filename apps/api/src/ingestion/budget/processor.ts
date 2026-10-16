import { sha256HexSync } from "@unprice/db/utils"
import {
  type BudgetCommand,
  type BudgetOutcome,
  type BudgetRejection,
  foldJournal,
  requestFingerprint,
  transition,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import type { BudgetProcessorDeps, BudgetStoreTx } from "./ports"

const HOUR_MS = 60 * 60 * 1000

export const INLINE_SWEEP_LIMIT = 32
export const ALARM_SWEEP_LIMIT = 256
export const ALARM_PURGE_LIMIT = 512
export const ALARM_COMPACT_LIMIT = 1_000
export const ALARM_CONTINUE_MS = 1_000
export const ALARM_RETRY_MS = 30_000
export const ALARM_HEARTBEAT_MS = 24 * HOUR_MS
/** Journal entries stay in the object this long before the alarm folds them into the base. */
export const JOURNAL_RETENTION_MS = 24 * HOUR_MS

type Committed =
  | { ok: true; outcome: BudgetOutcome; wakeAt: number | null }
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
    const committed = this.commit(
      withRequestHash(request),
      this.deps.clock.now(),
      INLINE_SWEEP_LIMIT
    )
    if (!committed.ok) return committed
    await this.lowerAlarm(committed.wakeAt)
    return { ok: true, outcome: committed.outcome }
  }

  /** Sweeper: lapses due holds, purges expired rows, compacts the journal, always re-arms. */
  async alarm(): Promise<void> {
    this.armedAt = null
    const now = this.deps.clock.now()
    let next: number | null
    try {
      next = this.sweep(now)
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

  private commit(command: BudgetCommand, clockMs: number, dueLimit: number): Committed {
    return this.deps.store.atomically((tx): Committed => {
      const ledger = tx.readLedger()
      const view = {
        budget: tx.readBudget(),
        ledger,
        target: readTarget(tx, command),
        due: tx.readDueHolds(Math.max(clockMs, ledger.lastAt), dueLimit),
      }
      const result = transition({ view, command, clockMs })
      if (result.err) return { ok: false, rejection: result.err.rejection }

      const { entries, next, operations, outcome, now, wakeAt } = result.val
      if (entries.length === 0) return { ok: true, outcome, wakeAt }
      tx.commit({
        budget: next.budget === view.budget ? null : next.budget,
        ledger: next.ledger,
        entries,
        operations,
        now,
      })
      const compactAt = now + JOURNAL_RETENTION_MS
      return {
        ok: true,
        outcome,
        wakeAt: wakeAt === null ? compactAt : Math.min(wakeAt, compactAt),
      }
    })
  }

  /** Returns the next wake, or null when the object holds no budget and so has no work. */
  private sweep(now: number): number | null {
    const swept = this.commit({ type: "sweep" }, now, ALARM_SWEEP_LIMIT)
    const lapsed = swept.ok && swept.outcome.type === "sweep" ? swept.outcome.lapsed : 0

    return this.deps.store.atomically((tx) => {
      if (tx.readBudget() === null) return null
      const purged = tx.purgeOperations(now, ALARM_PURGE_LIMIT)
      const head = tx.readJournalHead(now - JOURNAL_RETENTION_MS, ALARM_COMPACT_LIMIT)
      if (head.length > 0) tx.compactJournal(foldJournal(tx.readJournalBase(), head))

      if (
        lapsed === ALARM_SWEEP_LIMIT ||
        purged === ALARM_PURGE_LIMIT ||
        head.length === ALARM_COMPACT_LIMIT
      ) {
        return now + ALARM_CONTINUE_MS
      }
      const oldestEntryAt = tx.oldestEntryAt()
      const work = [
        tx.nextDueAt(),
        oldestEntryAt === null ? null : oldestEntryAt + JOURNAL_RETENTION_MS,
      ].filter((at): at is number => at !== null)
      // A floor keeps a row the sweep cannot clear from spinning the alarm.
      return work.length === 0
        ? now + ALARM_HEARTBEAT_MS
        : Math.max(Math.min(...work), now + ALARM_CONTINUE_MS)
    })
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

function withRequestHash(request: BudgetRequest): BudgetCommand {
  switch (request.type) {
    case "authorize":
    case "charge":
    case "record":
      return { ...request, requestHash: sha256HexSync(requestFingerprint(request)) }
    default:
      return request
  }
}

function readTarget(tx: BudgetStoreTx, command: BudgetCommand) {
  switch (command.type) {
    case "authorize":
    case "charge":
    case "record":
      return tx.readOperationByKey(command.idempotencyKey)
    case "settle":
    case "release":
      return tx.readOperation(command.holdId)
    default:
      return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
