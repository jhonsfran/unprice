import type { Result } from "@unprice/error"
import {
  type BudgetCommand,
  type BudgetReader,
  type BudgetRecord,
  type BudgetState,
  type BudgetTransition,
  type Entry,
  type HoldOperation,
  type Ledger,
  type Operation,
  RECORD_DEDUPE_MS,
  type UnPriceBudgetError,
  type WindowId,
  type WindowPeriod,
  dueAt,
  emptyLedger,
  loadView,
  recordKeysPurgeAt,
  transition,
  viewState,
} from "./index"

/**
 * Test double for the Durable Object store: rows indexed by id and idempotency key, a due-hold
 * scan, retention purge, the journal, the window history, and record keys. Loads its view the way
 * the store does and commits a transition only when it is Ok.
 */
export class MemoryBudgetStore implements BudgetReader {
  budget: BudgetRecord | null = null
  ledger: Ledger = emptyLedger
  readonly rows = new Map<string, Operation>()
  readonly entries: Entry[] = []
  readonly history: WindowPeriod[] = []
  /** Record key to the time its dedupe ends. */
  readonly recordKeys = new Map<string, number>()
  /** The projections the last transition started from, for `checkTransition`. */
  lastBefore: BudgetState | null = null
  private readonly byKey = new Map<string, string>()

  run(command: BudgetCommand, clockMs: number): Result<BudgetTransition, UnPriceBudgetError> {
    const view = loadView(this, command, clockMs, Number.MAX_SAFE_INTEGER)
    this.lastBefore = viewState(view)
    const result = transition({ view, command, clockMs })
    if (result.err) return result
    const { next, entries, operations } = result.val
    this.budget = next.budget
    this.ledger = next.ledger
    this.entries.push(...entries)
    for (const entry of entries) {
      if (entry.type === "window.rolled") {
        const { windowId, start, end, consumed } = entry
        this.history.push({ windowId, start, end, consumed })
      }
      if (entry.type === "recorded") {
        this.recordKeys.set(entry.idempotencyKey, entry.at + RECORD_DEDUPE_MS)
      }
    }
    for (const operation of operations) {
      this.rows.set(operation.id, operation)
      this.byKey.set(operation.idempotencyKey, operation.id)
    }
    return result
  }

  /** Deletes every closed row whose retention ended and every expired record key, as the alarm would. */
  purge(clockMs: number) {
    const keysAt = recordKeysPurgeAt(clockMs, this.ledger)
    for (const [key, expiresAt] of this.recordKeys) {
      if (expiresAt <= keysAt) this.recordKeys.delete(key)
    }
    for (const [id, operation] of this.rows) {
      const open = operation.kind === "hold" && operation.state.status === "open"
      if (open || dueAt(operation) > clockMs) continue
      this.rows.delete(id)
      this.byKey.delete(operation.idempotencyKey)
    }
  }

  readBudget() {
    return this.budget
  }

  readLedger() {
    return this.ledger
  }

  readOperation(id: string) {
    return this.rows.get(id) ?? null
  }

  readOperationByKey(idempotencyKey: string) {
    const id = this.byKey.get(idempotencyKey)
    return id === undefined ? null : this.readOperation(id)
  }

  readRecordKey(idempotencyKey: string, at: number) {
    return (this.recordKeys.get(idempotencyKey) ?? Number.NEGATIVE_INFINITY) > at
  }

  readHistory(windowIds: readonly WindowId[], limit: number) {
    return windowIds.flatMap((id) =>
      this.history
        .filter((period) => period.windowId === id)
        .sort((a, b) => b.start - a.start)
        .slice(0, limit)
    )
  }

  readDueHolds(at: number, limit: number) {
    const due: HoldOperation[] = []
    for (const operation of this.rows.values()) {
      if (
        operation.kind === "hold" &&
        operation.state.status === "open" &&
        operation.lapsesAt <= at
      ) {
        due.push(operation)
      }
    }
    return due.sort((a, b) => a.lapsesAt - b.lapsesAt).slice(0, limit)
  }
}
