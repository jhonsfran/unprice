import { cn } from "@unprice/ui/utils"
import type { ReactNode } from "react"

// The page-scale motif vocabulary, lifted from money-path.tsx so the whole
// home page reads as one annotated trace: station headers instead of badge
// eyebrows, ledger rows instead of feature cards, dotted leaders between a
// label and its monospace fact. Every fact rendered through these primitives
// is real product state — never decoration.

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

export function StationDot({
  variant = "default",
  className,
}: {
  variant?: "default" | "ghost" | "live" | "terminal"
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

export function SectionShell({
  id,
  labelledBy,
  className,
  innerClassName,
  children,
}: {
  id?: string
  labelledBy: string
  className?: string
  innerClassName?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("w-full border-background-border border-t", className)}
    >
      <div className={cn("mx-auto w-full max-w-6xl px-6 py-20 sm:py-24", innerClassName)}>
        {children}
      </div>
    </section>
  )
}
