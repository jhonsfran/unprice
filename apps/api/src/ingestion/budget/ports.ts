import type { BudgetReader, BudgetTransition, InspectReader } from "@unprice/services/budgets"
import type { CardRows } from "@unprice/services/pricing"
import type { BudgetJournal, JournalEntry } from "./journal"

export type BudgetClock = { now(): number }

export type BudgetLogger = { error(message: string, fields: Record<string, unknown>): void }

/** Host facilities for one budget's object. */
export type BudgetRuntime = {
  /** Deletes all of the object's storage and its alarm; afterwards the key has no budget. */
  destroy(): Promise<void>
}

export type BudgetScheduler = {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
}

/** Synchronous reads and writes bound to one SQLite transaction. Rows come back as domain types. */
export type BudgetStoreTx = BudgetReader & {
  /** Writes what an accepted transition returned. */
  commit(
    transition: Pick<
      BudgetTransition,
      | "budget"
      | "ledger"
      | "purged"
      | "operations"
      | "periods"
      | "retiredWindows"
      | "statements"
      | "positions"
      | "funding"
      | "now"
    >
  ): void
  /** Replaces the cached copy of each card with what the card source returned at `at`. */
  cacheCards(cards: readonly CardRows[], at: number): void
  /** Whether a wallet reservation is still open: the storage must outlive it. */
  hasOpenFunding(): boolean
  /** Deletes up to `limit` exported closed rows whose retention ended by `now`. */
  purgeOperations(now: number, limit: number): void
  /**
   * The earliest `alarmAt` of a row the alarm can act on: an open reservation's expiry, or an
   * exported closed row's retention end. A row waiting for export wakes the alarm through export.
   */
  nextDueAt(): number | null
  /** Up to `limit` written row versions the journal has not received, by `seq`. */
  readUnexported(limit: number): JournalEntry[]
  /** The journal received every row up to `seq`. */
  markExported(seq: number): void
}

export type Sync<T> = T extends PromiseLike<unknown> ? never : T

/**
 * One SQLite transaction. The callback type rejects a Promise: an await inside would let another
 * request interleave between check and debit, and writes before it could commit alone.
 */
export type BudgetStore = {
  atomically<T>(fn: (tx: BudgetStoreTx) => Sync<T>): T
  /** `atomically` with the reads only inspect makes, so no verb's transaction binds them. */
  inspecting<T>(fn: (tx: BudgetStoreTx & InspectReader) => Sync<T>): T
}

export type BudgetProcessorDeps = {
  /** Null when no stream is bound: rows wait, unpurged, until one is. */
  journal: BudgetJournal | null
  clock: BudgetClock
  logger: BudgetLogger
  runtime: BudgetRuntime
  scheduler: BudgetScheduler
  store: BudgetStore
}
