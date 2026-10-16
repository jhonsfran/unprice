import type { Result } from "@unprice/error"
import {
  type BudgetCommand,
  type BudgetRecord,
  type BudgetState,
  type BudgetTransition,
  type Entry,
  type HoldOperation,
  type Ledger,
  type Operation,
  type UnPriceBudgetError,
  dueAt,
  emptyLedger,
  transition,
} from "./core"

/**
 * Test double for the Durable Object store: rows indexed by id and idempotency key, a due-hold
 * scan, retention purge, and the journal. Commits a transition only when it is Ok.
 */
export class MemoryBudgetStore {
  budget: BudgetRecord | null = null
  ledger: Ledger = emptyLedger
  readonly rows = new Map<string, Operation>()
  readonly entries: Entry[] = []
  /** The projections the last transition started from, for `checkTransition`. */
  lastBefore: BudgetState | null = null
  private readonly byKey = new Map<string, string>()

  run(command: BudgetCommand, clockMs: number): Result<BudgetTransition, UnPriceBudgetError> {
    const view = this.view(command, clockMs)
    const loaded = new Map<string, Operation>(view.due.map((hold) => [hold.id, hold]))
    if (view.target) loaded.set(view.target.id, view.target)
    this.lastBefore = { budget: view.budget, ledger: view.ledger, operations: loaded }
    const result = transition({ view, command, clockMs })
    if (result.err) return result
    const { next, entries, operations } = result.val
    this.budget = next.budget
    this.ledger = next.ledger
    this.entries.push(...entries)
    for (const operation of operations) {
      this.rows.set(operation.id, operation)
      if (operation.kind !== "late_settle") this.byKey.set(operation.idempotencyKey, operation.id)
    }
    return result
  }

  /** Deletes every closed row whose retention ended, as the alarm would. */
  purge(clockMs: number) {
    for (const [id, operation] of this.rows) {
      const open = operation.kind === "hold" && operation.state.status === "open"
      if (open || dueAt(operation) > clockMs) continue
      this.rows.delete(id)
      if (operation.kind !== "late_settle") this.byKey.delete(operation.idempotencyKey)
    }
  }

  private view(command: BudgetCommand, clockMs: number) {
    let targetId: string | undefined
    if ("idempotencyKey" in command) targetId = this.byKey.get(command.idempotencyKey)
    if ("holdId" in command) targetId = command.holdId
    const now = Math.max(clockMs, this.ledger.lastAt)
    const due: HoldOperation[] = []
    for (const operation of this.rows.values()) {
      if (
        operation.kind === "hold" &&
        operation.state.status === "open" &&
        operation.lapsesAt <= now
      ) {
        due.push(operation)
      }
    }
    const target = targetId === undefined ? null : (this.rows.get(targetId) ?? null)
    return { budget: this.budget, ledger: this.ledger, target, due }
  }
}
