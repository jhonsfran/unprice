import type { Result } from "@unprice/error"
import {
  type BudgetCommand,
  type BudgetReader,
  type BudgetRecord,
  type BudgetTransition,
  type Ledger,
  type Operation,
  type ReservationOperation,
  type UnPriceBudgetError,
  WINDOW_HISTORY_PERIODS,
  type WindowId,
  type WindowPeriod,
  dueAt,
  emptyLedger,
  holdNumber,
  loadView,
  transition,
} from "./index"

/**
 * Test double for the Durable Object store: rows indexed by id and idempotency key, the window
 * history, and the alarm's sweep and purge. Loads its view the way the store does and writes a
 * transition only when it is Ok and says to write.
 */
export class MemoryBudgetStore implements BudgetReader {
  budget: BudgetRecord | null = null
  ledger: Ledger = emptyLedger
  readonly rows = new Map<string, Operation>()
  /** Up to WINDOW_HISTORY_PERIODS periods per window id, newest first, as the store keeps them. */
  readonly history = new Map<WindowId, WindowPeriod[]>()
  /** How many transitions wrote. */
  writes = 0
  private readonly byKey = new Map<string, string>()

  run(command: BudgetCommand, clockMs: number): Result<BudgetTransition, UnPriceBudgetError> {
    const view = loadView(this, command, clockMs)
    const result = transition({ view, command, clockMs })
    if (result.err || !result.val.write) return result
    const { budget, ledger, purged, operations, periods, retiredWindows } = result.val
    this.writes += 1
    if (budget) this.budget = budget
    this.ledger = ledger
    for (const id of retiredWindows) this.history.delete(id)
    for (const period of periods) {
      const kept = [period, ...(this.history.get(period.windowId) ?? [])]
      this.history.set(period.windowId, kept.slice(0, WINDOW_HISTORY_PERIODS))
    }
    for (const operation of purged) this.rows.delete(operation.id)
    for (const operation of operations) {
      this.rows.set(operation.id, operation)
      if (operation.kind !== "lease") this.byKey.set(operation.idempotencyKey, operation.id)
    }
    return result
  }

  /**
   * What the alarm does: sweeps, which moves the clock to `clockMs` and closes expired holds and
   * leases, then purges closed rows.
   */
  alarm(clockMs: number) {
    if (!this.budget) return
    const swept = this.run({ type: "sweep" }, clockMs)
    if (swept.err) throw swept.err
    for (const [id, operation] of this.rows) {
      const due = dueAt(operation)
      if (due === null || due > swept.val.now) continue
      this.rows.delete(id)
      if (operation.kind !== "lease") this.byKey.delete(operation.idempotencyKey)
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

  readLease(leaseKey: string) {
    const row = this.rows.get(`l:${leaseKey}`)
    return row?.kind === "lease" ? row : null
  }

  readHistory(windowIds: readonly WindowId[], limit: number) {
    return windowIds.flatMap((id) => (this.history.get(id) ?? []).slice(0, limit))
  }

  readExpired(now: number, limit: number) {
    const order = (row: ReservationOperation) => (row.kind === "hold" ? holdNumber(row.id) : 0)
    return [...this.rows.values()]
      .filter(
        (row): row is ReservationOperation =>
          (row.kind === "hold" || row.kind === "lease") &&
          row.state.status === "open" &&
          row.expiresAt <= now
      )
      .sort(
        (a, b) =>
          a.expiresAt - b.expiresAt ||
          Number(a.kind === "lease") - Number(b.kind === "lease") ||
          order(a) - order(b) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limit)
  }
}
