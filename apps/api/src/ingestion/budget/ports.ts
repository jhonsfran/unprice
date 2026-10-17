import type { BudgetReader, BudgetTransition } from "@unprice/services/budgets"

export type BudgetClock = { now(): number }

export type BudgetLogger = { error(message: string, fields: Record<string, unknown>): void }

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
      "budget" | "ledger" | "purged" | "operations" | "periods" | "retiredWindows" | "now"
    >
  ): void
  /** Deletes up to `limit` closed rows whose retention ended by `now`. */
  purgeOperations(now: number, limit: number): void
  /** The earliest end of retention among closed rows. Open holds have no cleanup deadline. */
  nextDueAt(): number | null
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
