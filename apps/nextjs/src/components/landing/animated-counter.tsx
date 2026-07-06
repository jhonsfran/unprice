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
  const [displayValue, setDisplayValue] = useState(value)
  const previousValue = useRef(value)

  useEffect(() => {
    if (value !== previousValue.current) {
      const start = previousValue.current
      const end = value
      const startTime = performance.now()

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime
        const progress = Math.min(elapsed / duration, 1)
        const easeProgress = 1 - (1 - progress) ** 3
        const current = start + (end - start) * easeProgress
        setDisplayValue(current)
        if (progress < 1) requestAnimationFrame(animate)
      }

      requestAnimationFrame(animate)
      previousValue.current = value
    }
  }, [value, duration])

  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {prefix}
      {displayValue.toFixed(decimals)}
    </span>
  )
}
