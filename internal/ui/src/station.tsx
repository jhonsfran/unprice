import type { ReactNode } from "react"

import { cn } from "./utils"

// The money-path motif vocabulary, promoted from the landing page so app
// surfaces (onboarding, dashboards) and marketing render the same grammar:
// station dots on a rail, dotted leaders between a label and its monospace
// fact. Every fact rendered through these primitives is real product state —
// never decoration.

export function Leader({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mx-1 min-w-4 flex-1 self-center border-background-border border-b border-dotted",
        className
      )}
    />
  )
}

export type StationDotVariant = "default" | "ghost" | "live" | "terminal" | "danger" | "warning"

export function StationDot({
  variant = "default",
  className,
}: {
  variant?: StationDotVariant
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-[9px] shrink-0 rounded-full",
        variant === "default" && "border border-background-borderHover bg-background-base",
        variant === "ghost" && "border border-background-borderHover border-dashed",
        variant === "live" && "bg-info ring-2 ring-info-bg",
        variant === "terminal" && "bg-success-solid",
        variant === "danger" && "bg-danger-solid",
        variant === "warning" && "border border-warning-border bg-warning-bg",
        className
      )}
    />
  )
}

// label · dotted leader · mono fact. The receipt row.
export function LedgerRow({
  label,
  fact,
  variant = "default",
  labelClassName,
  factClassName,
}: {
  label: ReactNode
  fact: ReactNode
  variant?: "default" | "ghost"
  labelClassName?: string
  factClassName?: string
}) {
  return (
    <div className="flex items-baseline gap-2 py-[5px]">
      <span
        className={cn(
          "text-sm",
          variant === "ghost" ? "text-background-text" : "font-medium text-background-textContrast",
          labelClassName
        )}
      >
        {label}
      </span>
      <Leader />
      <span
        className={cn(
          "text-right font-mono text-[11px] text-background-text leading-5",
          factClassName
        )}
      >
        {fact}
      </span>
    </div>
  )
}
