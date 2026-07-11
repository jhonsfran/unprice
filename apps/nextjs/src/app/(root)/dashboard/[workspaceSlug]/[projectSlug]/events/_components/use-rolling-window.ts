"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ANALYTICS_REFRESH_INTERVAL_MS,
  DEFAULT_INGESTION_HEALTH_WINDOW_MS,
} from "~/components/analytics/ingestion-health-query"

function computeWindowLabel(from: number, to: number): string {
  const diffMs = to - from
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  if (diffHours <= 1) return "in the last hour"
  if (diffHours < 24) return `in the last ${diffHours} hours`
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 1) return "today"
  return `in the last ${diffDays} days`
}

function resolveWindow(
  from: number | null,
  to: number | null,
  now: number
): { from: number; to: number } {
  return {
    from: from ?? now - DEFAULT_INGESTION_HEALTH_WINDOW_MS,
    to: to ?? now,
  }
}

/**
 * Resolves the query window from an optional explicit date range. When no range is set the window
 * rolls forward: it advances every {@link ANALYTICS_REFRESH_INTERVAL_MS} and on window focus.
 */
export function useRollingWindow(from: number | null, to: number | null) {
  const [rollingNow, setRollingNow] = useState(() => Date.now())
  const hasExplicitDateRange = from !== null || to !== null
  const queryWindow = useMemo(() => resolveWindow(from, to, rollingNow), [from, to, rollingNow])

  useEffect(() => {
    if (hasExplicitDateRange) {
      return
    }

    const refresh = () => setRollingNow(Date.now())
    refresh()
    const intervalId = globalThis.setInterval(refresh, ANALYTICS_REFRESH_INTERVAL_MS)
    globalThis.addEventListener("focus", refresh)

    return () => {
      globalThis.clearInterval(intervalId)
      globalThis.removeEventListener("focus", refresh)
    }
  }, [hasExplicitDateRange])

  return {
    queryWindow,
    hasExplicitDateRange,
    windowLabel: computeWindowLabel(queryWindow.from, queryWindow.to),
  }
}
