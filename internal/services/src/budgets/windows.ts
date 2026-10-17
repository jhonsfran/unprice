/**
 * Budget limit windows (ADR-0006 B1): UTC calendar windows and anchored windows.
 *
 * A limit resets at the start of its window. "never" is one window that starts at 0 and has no end.
 * An anchored window repeats every day, week, or month from an anchor instant, forward and
 * backward. Usage is counted per window id, so every limit on the same window shares one counter.
 * Keep this module pure: no clock reads, no storage.
 */

import { BUDGET_ANCHORED_WINDOWS, BUDGET_WINDOWS } from "@unprice/db/validators"

export { BUDGET_ANCHORED_WINDOWS, BUDGET_WINDOWS }

export type BudgetWindow = (typeof BUDGET_WINDOWS)[number]
export type AnchoredWindow = (typeof BUDGET_ANCHORED_WINDOWS)[number]

/** A limit's window: a calendar window, or with `anchor` (epoch ms) an anchored day, week, or month. */
export type WindowSpec = Readonly<{ window: BudgetWindow; anchor?: number }>

/** `hour|day|week|month|never`, or `<every>@<anchor ISO>` for an anchored window. */
export type AnchoredWindowId = `${AnchoredWindow}@${string}`
export type WindowId = BudgetWindow | AnchoredWindowId

export type BudgetWindowBounds = {
  start: number
  /** Exclusive. `null` for the "never" window. */
  end: number | null
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export function isAnchoredWindow(window: BudgetWindow): window is AnchoredWindow {
  return (BUDGET_ANCHORED_WINDOWS as readonly string[]).includes(window)
}

export function windowIdOf(spec: WindowSpec): WindowId {
  if (spec.anchor === undefined) return spec.window
  if (!isAnchoredWindow(spec.window)) throw new Error(`window ${spec.window} cannot be anchored`)
  return `${spec.window}@${new Date(spec.anchor).toISOString()}`
}

export function windowSpecOf(id: WindowId): WindowSpec {
  const at = id.indexOf("@")
  if (at === -1) return { window: id as BudgetWindow }
  return { window: id.slice(0, at) as AnchoredWindow, anchor: Date.parse(id.slice(at + 1)) }
}

export function windowBounds(spec: WindowSpec, nowMs: number): BudgetWindowBounds {
  if (spec.anchor === undefined) return budgetWindowBounds(spec.window, nowMs)
  if (!isAnchoredWindow(spec.window)) throw new Error(`window ${spec.window} cannot be anchored`)
  return anchoredWindowBounds(spec.window, spec.anchor, nowMs)
}

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

/**
 * Periods of length `every` starting at `anchor`. Days and weeks are fixed lengths (UTC has no
 * DST). A month period keeps the anchor's day of month and time of day, and starts on the last
 * day of a month too short for it: an anchor on the 31st starts periods on Feb 28 (29), Apr 30.
 */
export function anchoredWindowBounds(
  every: AnchoredWindow,
  anchor: number,
  nowMs: number
): { start: number; end: number } {
  switch (every) {
    case "day":
    case "week": {
      const length = every === "day" ? DAY_MS : WEEK_MS
      const start = anchor + Math.floor((nowMs - anchor) / length) * length
      return { start, end: start + length }
    }
    case "month": {
      const now = new Date(nowMs)
      const from = new Date(anchor)
      let offset =
        (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - from.getUTCMonth())
      if (monthPeriodStart(from, offset) > nowMs) offset -= 1
      return { start: monthPeriodStart(from, offset), end: monthPeriodStart(from, offset + 1) }
    }
  }
}

function monthPeriodStart(anchor: Date, offset: number): number {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + offset
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const timeOfDay = anchor.getTime() - Date.UTC(year, anchor.getUTCMonth(), anchor.getUTCDate())
  return Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay)) + timeOfDay
}
