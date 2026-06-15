"use client"
import { Progress } from "@unprice/ui/progress"
import { cn } from "@unprice/ui/utils"

export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number
  max: number
  className?: string
}) {
  // for inifinity, set max to 999999
  const progress = (value / (max === Number.POSITIVE_INFINITY ? 999999 : max)) * 100

  return (
    <div className="flex items-center">
      <Progress value={progress} className={cn("h-2 w-full", className)} max={100} />
      {/* <span className="ml-2 text-content-subtle text-xs">{nFormatter(value)}</span> */}
    </div>
  )
}
