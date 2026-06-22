import { z } from "zod"

export const DEFAULT_INTERVALS = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
} as const

export const analyticsIntervalSchema = z.enum(["24h", "7d", "30d", "90d"] as const)

export type Interval = keyof typeof DEFAULT_INTERVALS
export const INTERVAL_KEYS = Object.keys(DEFAULT_INTERVALS) as Array<keyof typeof DEFAULT_INTERVALS>
export const DEFAULT_INTERVAL = "24h"

export function prepareInterval(interval: Interval) {
  const now = Date.now()

  switch (interval) {
    case "24h": {
      const intervalMs = 1000 * 60 * 60 * 24
      return {
        start: now - intervalMs,
        end: now,
        intervalMs,
        intervalDays: 1,
        granularity: "hour",
        label: "last 24 hours",
        durationLabel: "24 hours",
        // format should be meaningful for the user depending on the interval
        dateFormat: "MMM d hh:mm",
        name: "24h" as const,
        hotkey: "D",
      }
    }
    case "7d": {
      const intervalMs = 1000 * 60 * 60 * 24 * 7
      return {
        start: now - intervalMs,
        end: now,
        intervalMs,
        intervalDays: 7,
        granularity: "day",
        label: "last 7 days",
        durationLabel: "7 days",
        dateFormat: "MMM d",
        name: "7d" as const,
        hotkey: "W",
      }
    }
    case "30d": {
      const intervalMs = 1000 * 60 * 60 * 24 * 30
      return {
        start: now - intervalMs,
        end: now,
        intervalMs,
        intervalDays: 30,
        granularity: "day",
        label: "last 30 days",
        durationLabel: "30 days",
        dateFormat: "MMM d",
        name: "30d" as const,
        hotkey: "M",
      }
    }
    case "90d": {
      const intervalMs = 1000 * 60 * 60 * 24 * 90
      return {
        start: now - intervalMs,
        end: now,
        intervalMs,
        intervalDays: 90,
        granularity: "day",
        label: "last 90 days",
        durationLabel: "90 days",
        dateFormat: "MMM d",
        name: "90d" as const,
        hotkey: "Y",
      }
    }
  }
}

export function preparePage(pageId: string) {
  const isValidPage = pageId.startsWith("page_")
  return {
    pageId: isValidPage ? pageId : "all",
    isSelected: !!isValidPage, // if the page is valid, it is selected
  }
}
