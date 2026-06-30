"use client"

import { cn } from "@unprice/ui/utils"
import { RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

const ABSOLUTE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "short",
})

type FreshnessIndicatorProps = {
  generatedAt: number | null | undefined
  isFetching?: boolean
  className?: string
}

export function FreshnessIndicator({
  generatedAt,
  isFetching = false,
  className,
}: FreshnessIndicatorProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => setNow(Date.now()), 30_000)

    return () => globalThis.clearInterval(intervalId)
  }, [])

  if (!generatedAt) {
    return null
  }

  const absoluteTime = ABSOLUTE_TIME_FORMAT.format(generatedAt)
  const relativeTime = formatRelativeTime(generatedAt, now)

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs", className)}
      title={`Last updated ${absoluteTime}`}
    >
      <RefreshCw className={cn("size-3", isFetching && "animate-spin")} />
      <span suppressHydrationWarning>Last updated {relativeTime}</span>
      <span className="hidden sm:inline">({absoluteTime})</span>
    </div>
  )
}

function formatRelativeTime(timestamp: number, now: number): string {
  const diffSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))

  if (diffSeconds < 10) {
    return "just now"
  }

  if (diffSeconds < 60) {
    return RELATIVE_TIME_FORMAT.format(-diffSeconds, "second")
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return RELATIVE_TIME_FORMAT.format(-diffMinutes, "minute")
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return RELATIVE_TIME_FORMAT.format(-diffHours, "hour")
  }

  const diffDays = Math.floor(diffHours / 24)
  return RELATIVE_TIME_FORMAT.format(-diffDays, "day")
}
