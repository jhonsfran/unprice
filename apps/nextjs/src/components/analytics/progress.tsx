"use client"
import { Progress } from "@unprice/ui/progress"
import { cn } from "@unprice/ui/utils"
import type { ComponentProps } from "react"

type ProgressVariant = ComponentProps<typeof Progress>["variant"]

export function ProgressBar({
  value,
  max,
  className,
  variant = "info",
}: {
  value: number
  max: number
  className?: string
  variant?: ProgressVariant
}) {
  // for inifinity, set max to 999999
  const progress = (value / (max === Number.POSITIVE_INFINITY ? 999999 : max)) * 100

  return (
    <div className="flex items-center">
      <Progress
        value={progress}
        className={cn("h-2 w-full", className)}
        max={100}
        variant={variant}
      />
      {/* <span className="ml-2 text-content-subtle text-xs">{nFormatter(value)}</span> */}
    </div>
  )
}
