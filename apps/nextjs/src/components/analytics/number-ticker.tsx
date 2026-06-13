"use client"

import { useInView, useMotionValue, useSpring } from "framer-motion"
import { type ComponentPropsWithoutRef, useEffect, useRef } from "react"

import { nFormatter, nFormatterTime } from "@unprice/db/utils"
import { cn } from "@unprice/ui/utils"

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  direction?: "up" | "down"
  delay?: number
  isTime?: boolean
  decimalPlaces?: number
  withFormatter?: boolean
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  withFormatter = true,
  isTime = false,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionValue = useMotionValue(direction === "down" ? value : startValue)
  const springValue = useSpring(motionValue, {
    damping: 20,
    stiffness: 100,
  })
  const isInView = useInView(ref, { once: true, margin: "0px" })

  useEffect(() => {
    if (isInView) {
      const timer = setTimeout(() => {
        motionValue.set(direction === "down" ? startValue : value)
      }, delay * 1000)
      return () => clearTimeout(timer)
    }
  }, [motionValue, isInView, delay, value, direction, startValue])

  useEffect(() => {
    const unsubscribe = springValue.on("change", (latest: number) => {
      if (ref.current) {
        const formattedValue = withFormatter
          ? isTime
            ? nFormatterTime(latest, { digits: decimalPlaces })
            : nFormatter(latest, { digits: decimalPlaces })
          : Intl.NumberFormat("en-US", {
              minimumFractionDigits: decimalPlaces,
              maximumFractionDigits: decimalPlaces,
            }).format(Number(latest.toFixed(decimalPlaces)))
        ref.current.textContent = formattedValue
      }
    })
    return () => unsubscribe()
  }, [springValue, decimalPlaces])

  return (
    <span
      ref={ref}
      className={cn("inline-block tabular-nums tracking-wider", className)}
      {...props}
    >
      {startValue}
    </span>
  )
}
