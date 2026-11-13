import { formatAmount } from "@unprice/money"
import {
  type BudgetBalance,
  type BudgetRejection,
  type BudgetSnapshot,
  type Operation,
  type OutcomeOf,
  type ReservationOperation,
  type Usage,
  type WindowPeriod,
  formatBudgetConfig,
} from "@unprice/services/budgets"

/** A budget value on the wire: every amount (a `bigint`) becomes its canonical decimal string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Wire<T[K]> }
      : T

export function toWire<T>(value: T): Wire<T> {
  return wire(value) as Wire<T>
}

function wire(value: unknown): unknown {
  if (typeof value === "bigint") return formatAmount(value)
  if (Array.isArray(value)) return value.map(wire)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]))
  }
  return value
}

// The public wire carries amounts only. The core counts a usage vector (the amount and a quantity
// per feature), so every vector projects to its amount here, and a limit that caps a quantity names
// its `feature`, as `formatBudgetConfig` does.

export function amountToWire(usage: Usage): string {
  return formatAmount(usage.amount)
}

export function balanceToWire({ remaining, held, limits, asOf }: BudgetBalance) {
  return {
    remaining: remaining === null ? null : formatAmount(remaining),
    held: amountToWire(held),
    limits: limits.map(({ measure, ...limit }) => ({
      ...toWire(limit),
      ...(measure.type === "quantity" && { feature: measure.feature }),
    })),
    asOf,
  }
}

export function periodToWire({ consumed, ...period }: WindowPeriod) {
  return { ...period, consumed: amountToWire(consumed) }
}

/** A hold or lease row as the dashboard's inspection reads it. */
export function reservationToWire(row: ReservationOperation) {
  if (row.kind === "lease") return toWire(row)
  const { reserved, state, ...hold } = row
  return {
    // An estimate carries the bigints of the event it priced.
    ...toWire(hold),
    amount: amountToWire(reserved),
    state:
      state.status === "settled" ? { ...toWire(state), actual: amountToWire(state.actual) } : state,
  }
}

/** An operation row as the dashboard's inspection reads it. */
export function operationToWire(row: Operation) {
  if (row.kind === "hold" || row.kind === "lease") return reservationToWire(row)
  const { usage, ...operation } = row
  return { ...toWire(operation), amount: amountToWire(usage) }
}

/**
 * A budget on the wire: its config with every default filled, amounts as decimals, and closesAt in
 * epoch ms, as `formatBudgetConfig` returns it.
 */
export function budgetToWire(budget: BudgetSnapshot) {
  const { key, unit, version, closed, balance, operations } = budget
  const config = formatBudgetConfig(budget)
  return { key, unit, version, ...config, closed, balance: balanceToWire(balance), operations }
}

export function releaseToWire({
  released,
  balance,
  ...outcome
}: Omit<OutcomeOf<"release">, "type">) {
  return { ...toWire(outcome), released: amountToWire(released), balance: balanceToWire(balance) }
}

/** A charge or record: the amount it consumed. */
export function consumedToWire({
  usage,
  balance,
  ...outcome
}: Omit<OutcomeOf<"charge"> | OutcomeOf<"record">, "type" | "created">) {
  return { ...toWire(outcome), amount: amountToWire(usage), balance: balanceToWire(balance) }
}

/** An admission rejection as `details` carries it, with its code instead of a kind. */
export function admissionToWire(
  rejection: Extract<BudgetRejection, { code: "BUDGET_CLOSED" | "LIMIT_EXCEEDED" }>
) {
  if (rejection.code === "BUDGET_CLOSED") return rejection
  return {
    code: rejection.code,
    blocked: toWire(rejection.blocked),
    balance: balanceToWire(rejection.balance),
  }
}

/** A report's extension; a short one carries the details a denied charge would have. */
export function extensionToWire(
  { requested, granted, denied }: OutcomeOf<"report">["extension"],
  balance: BudgetBalance
) {
  const wire = { requested: formatAmount(requested), granted: formatAmount(granted) }
  if (denied === null) return wire
  const details =
    denied.code === "LIMIT_EXCEEDED"
      ? {
          kind: "budget_exceeded" as const,
          blocked: toWire(denied.blocked),
          balance: balanceToWire(balance),
        }
      : { kind: "budget_closed" as const, closedAt: denied.closedAt }
  return { ...wire, denied: details }
}
