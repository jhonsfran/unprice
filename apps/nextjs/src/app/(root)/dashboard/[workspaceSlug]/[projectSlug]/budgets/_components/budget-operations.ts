import type { RouterOutputs } from "@unprice/trpc/routes"
import { formatBudgetAmount, subtractAmount } from "./budget-format"

export type BudgetInspection = RouterOutputs["budgets"]["inspect"]
export type BudgetOperation = BudgetInspection["closedRecently"][number]

/** One line of an operation row: what happened, to which id, for how much, and when. */
export type OperationLine = { kind: string; id: string; detail: string; at: number }

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
      detail: state.byExpiry
        ? `${amount(state.actual)} (expired, charged in full)`
        : `${amount(state.actual)} of ${amount(operation.amount)} held`,
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
