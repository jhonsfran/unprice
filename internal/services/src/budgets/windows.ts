/**
 * UTC calendar windows for budget limits (ADR-0006 B1).
 *
 * A limit resets at the start of its window. "never" is one window that starts at 0 and has no end.
 * Keep this module pure: no clock reads, no storage.
 */

export const BUDGET_WINDOWS = ["hour", "day", "week", "month", "never"] as const

export type BudgetWindow = (typeof BUDGET_WINDOWS)[number]

export type BudgetWindowBounds = {
  start: number
  /** Exclusive. `null` for the "never" window. */
  end: number | null
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function budgetWindowBounds(window: BudgetWindow, nowMs: number): BudgetWindowBounds {
  switch (window) {
    case "never":
      return { start: 0, end: null }
    case "hour": {
      const start = Math.floor(nowMs / HOUR_MS) * HOUR_MS
      return { start, end: start + HOUR_MS }
    }
    case "day": {
      const start = Math.floor(nowMs / DAY_MS) * DAY_MS
      return { start, end: start + DAY_MS }
    }
    case "week": {
      // ISO weeks start on Monday.
      const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS
      const weekday = (new Date(dayStart).getUTCDay() + 6) % 7
      const start = dayStart - weekday * DAY_MS
      return { start, end: start + 7 * DAY_MS }
    }
    case "month": {
      const date = new Date(nowMs)
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
      const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      return { start, end }
    }
  }
}
