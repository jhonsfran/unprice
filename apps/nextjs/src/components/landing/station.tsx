import { cn } from "@unprice/ui/utils"
import type { ReactNode } from "react"

// The page-scale motif vocabulary: station headers instead of badge eyebrows,
// ledger rows instead of feature cards, dotted leaders between a label and its
// monospace fact. The atoms (StationDot, Leader, LedgerRow) are shared with
// app surfaces via @unprice/ui/station and re-exported here so landing
// sections keep one import path. Every fact rendered through these primitives
// is real product state — never decoration.

export { Leader, LedgerRow, StationDot } from "@unprice/ui/station"

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
      {/* The content column carries hairline rails, so stacked sections read
          as cells of one continuous ledger sheet. The + ticks are
          registration marks where a section rule crosses the rails. */}
      <div
        className={cn(
          "relative mx-auto w-full max-w-6xl border-[color:var(--rail)] px-6 py-20 sm:py-24 lg:border-x",
          innerClassName
        )}
      >
        <span
          aria-hidden
          className="-top-[7px] -left-[4.5px] absolute hidden select-none bg-surface-page font-mono text-[11px] text-background-border leading-none lg:block"
        >
          +
        </span>
        <span
          aria-hidden
          className="-top-[7px] -right-[4.5px] absolute hidden select-none bg-surface-page font-mono text-[11px] text-background-border leading-none lg:block"
        >
          +
        </span>
        {children}
      </div>
    </section>
  )
}
