"use client"

import * as ProgressPrimitive from "@radix-ui/react-progress"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import * as React from "react"

import { cn } from "./utils"

const fillVariants = cva("h-full rounded-full transition-[width] duration-200", {
  variants: {
    variant: {
      default: "bg-background-solid",
      primary: "bg-primary-solid",
      destructive: "bg-danger-solid",
      secondary: "bg-secondary-solid",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
})

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & VariantProps<typeof fillVariants>
>(({ className, variant, value, max, ...props }, ref) => {
  const ceiling = max ?? 100
  const percent = Math.min(100, Math.max(0, ((value ?? 0) / ceiling) * 100))
  // Consumption meters escalate as the allowance drains: primary while
  // healthy, warning from 80%, danger when exhausted. Explicit non-primary
  // variants opt out of the escalation.
  const thresholdClass =
    variant == null || variant === "primary"
      ? percent >= 100
        ? "bg-danger-solid"
        : percent >= 80
          ? "bg-warning-solid"
          : undefined
      : undefined

  return (
    <ProgressPrimitive.Root
      ref={ref}
      max={ceiling}
      value={Math.min(value ?? 0, ceiling)}
      className={cn(
        // the track is neutral rail; only the fill carries color, so an
        // untouched allowance reads as empty instead of exhausted
        "relative h-4 w-full overflow-hidden rounded-full bg-background-bgHover",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(fillVariants({ variant }), thresholdClass)}
        style={{ width: `${percent}%` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
