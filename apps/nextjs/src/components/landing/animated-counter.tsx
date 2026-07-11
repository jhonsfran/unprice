"use client"

import { cn } from "@unprice/ui/utils"
import { useEffect, useRef, useState } from "react"

// Shared numeric transition for real amounts: counts between values with an
// ease-out cubic. Used by the pricing simulator's live totals and by the
// money path's budget. Renders the final value directly on first paint, so
// SSR and reduced-motion states are always correct.

export function AnimatedCounter({
  value,
  prefix = "",
  decimals = 0,
  duration = 150,
  className,
}: {
  value: number
  prefix?: string
  decimals?: number
  duration?: number
  className?: string
}) {
  // Only the in-flight animation frame lives in state — it is null whenever
  // the counter is at rest, so render reads the `value` prop directly. That
  // keeps SSR/first paint and reduced-motion correct and means a changed prop
  // can never leave a stale copy behind (react-doctor/no-derived-useState).
  const [animatedValue, setAnimatedValue] = useState<number | null>(null)
  const previousValue = useRef(value)

  useEffect(() => {
    if (value === previousValue.current) return

    const start = previousValue.current
    const end = value
    const startTime = performance.now()
    previousValue.current = value

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const easeProgress = 1 - (1 - progress) ** 3
      if (progress < 1) {
        setAnimatedValue(start + (end - start) * easeProgress)
        requestAnimationFrame(animate)
      } else {
        // Settle back onto the prop so render stops reading interim state.
        setAnimatedValue(null)
      }
    }

    requestAnimationFrame(animate)
  }, [value, duration])

  const displayValue = animatedValue ?? value

  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {prefix}
      {displayValue.toFixed(decimals)}
    </span>
  )
}
