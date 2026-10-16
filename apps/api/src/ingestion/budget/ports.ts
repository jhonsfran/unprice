import type {
  BudgetReader,
  BudgetRecord,
  Entry,
  Ledger,
  Operation,
} from "@unprice/services/budgets"

export type BudgetClock = { now(): number }

export type BudgetLogger = { error(message: string, fields: Record<string, unknown>): void }

export type BudgetScheduler = {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
}

/** Synchronous reads and writes bound to one SQLite transaction. Rows come back as domain types. */
export type BudgetStoreTx = BudgetReader & {
  commit(params: {
    budget: BudgetRecord | null
    ledger: Ledger
    entries: readonly Entry[]
    operations: readonly Operation[]
    now: number
  }): void
  /** Deletes up to `limit` closed rows whose retention ended. */
  purgeOperations(now: number, limit: number): void
  /** Deletes up to `limit` of the oldest journal entries with `at < before`. */
  pruneJournal(before: number, limit: number): void
  nextDueAt(): number | null
  oldestEntryAt(): number | null
}

export type Sync<T> = T extends PromiseLike<unknown> ? never : T

/**
 * One SQLite transaction. The callback type rejects a Promise: an await inside would let another
 * request interleave between check and debit, and writes before it could commit alone.
 */
export type BudgetStore = {
  atomically<T>(fn: (tx: BudgetStoreTx) => Sync<T>): T
}

export type BudgetProcessorDeps = {
  clock: BudgetClock
  logger: BudgetLogger
  scheduler: BudgetScheduler
  store: BudgetStore
}
