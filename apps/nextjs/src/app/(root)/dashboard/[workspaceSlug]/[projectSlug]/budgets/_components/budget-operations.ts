import type { RouterOutputs } from "@unprice/trpc/routes"
import { formatBudgetAmount, subtractAmount } from "./budget-format"

export type BudgetInspection = RouterOutputs["budgets"]["inspect"]
export type BudgetOperation = BudgetInspection["closedRecently"][number]

/** One line of an operation row: what happened, to which id, for how much, and when. */
export type OperationLine = { kind: string; id: string; detail: string; at: number }

type SettledHold = Extract<
  Extract<BudgetOperation, { kind: "hold" }>["state"],
  { status: "settled" }
>

/**
 * A settle against its hold. The budget settles an expired hold: an estimate at its event's price,
 * else in full, or in full and unbilled when no statement could take the estimate.
 */
function settleDetail(state: SettledHold, held: string, amount: (value: string) => string) {
  const actual = amount(state.actual)
  if (!state.byExpiry) return `${actual} of ${amount(held)} held`
  if (state.unbilled) return `${actual} (expired, unbilled: ${state.unbilled.reason})`
  if (state.priced) return `${actual} of ${amount(held)} held (expired, billed at its price)`
  return `${actual} (expired, charged in full)`
}

export function describeOperation(operation: BudgetOperation, unit: string): OperationLine {
  const amount = (value: string) => formatBudgetAmount(value, unit)

  if (operation.kind === "hold") {
    const { state } = operation
    if (state.status === "open") {
      return {
        kind: "hold",
        id: operation.id,
        detail: `${amount(operation.amount)} held`,
        at: operation.createdAt,
      }
    }
    if (state.status === "released") {
      return {
        kind: "release",
        id: operation.id,
        detail: `${amount(operation.amount)} returned`,
        at: state.closedAt,
      }
    }
    return {
      kind: "settle",
      id: operation.id,
      detail: settleDetail(state, operation.amount, amount),
      at: state.closedAt,
    }
  }

  if (operation.kind === "lease") {
    const { state } = operation
    const captured = `${amount(operation.captured)} of ${amount(operation.granted)} captured`
    if (state.status === "open") {
      return {
        kind: "lease",
        id: operation.leaseKey,
        detail: `${amount(subtractAmount(operation.granted, operation.captured))} left of ${amount(operation.granted)}`,
        at: operation.createdAt,
      }
    }
    if (state.status === "refused") {
      return {
        kind: "lease",
        id: operation.leaseKey,
        detail: `refused by ${state.blocked.limitId}`,
        at: state.closedAt,
      }
    }
    return {
      kind: "lease",
      id: operation.leaseKey,
      detail: state.status === "expired" ? `${captured} (expired)` : captured,
      at: state.closedAt,
    }
  }

  return {
    kind: operation.kind,
    id: operation.idempotencyKey,
    detail: amount(operation.amount),
    at: operation.createdAt,
  }
}
