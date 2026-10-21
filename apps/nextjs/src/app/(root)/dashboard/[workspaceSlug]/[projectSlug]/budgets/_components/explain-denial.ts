import { formatDate } from "~/lib/dates"
import { formatBudgetAmount } from "./budget-format"
import type { BudgetInspection } from "./budget-operations"

type ProbeRejection = NonNullable<NonNullable<BudgetInspection["probe"]>["rejection"]>
export type BudgetBlocked = Extract<ProbeRejection, { code: "LIMIT_EXCEEDED" }>["blocked"]

export function explainRejection(rejection: ProbeRejection, unit: string): string {
  if (rejection.code === "BUDGET_CLOSED") {
    return `Denied: the budget closed ${formatDate(rejection.closedAt, "UTC", "MMM d, HH:mm")} UTC.`
  }
  return explainDenial(rejection.blocked, unit)
}

const ADVICE: Record<BudgetBlocked["remedy"], string> = {
  release_holds: "Release stuck holds or raise the limit.",
  wait_for_reset: "Wait for the reset or raise the limit.",
  raise_limit: "Releasing holds or waiting for the reset is not enough. Raise the limit.",
}

/** The sentence an operator reads for a denial. Only hard limits deny, so the limit is hard. */
export function explainDenial(blocked: BudgetBlocked, unit: string): string {
  const amount = (value: string) => formatBudgetAmount(value, unit)
  const room = blocked.remaining.startsWith("-")
    ? `over by ${amount(blocked.remaining.slice(1))}`
    : `${amount(blocked.remaining)} left`
  const resets =
    blocked.resetsAt === null
      ? "It never resets."
      : `Resets ${formatDate(blocked.resetsAt, "UTC", "MMM d, HH:mm")} UTC.`

  return `Denied by ${blocked.limitId} (hard, ${blocked.window}): ${room} with ${amount(blocked.held)} held. ${resets} ${ADVICE[blocked.remedy]}`
}
