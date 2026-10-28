import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import type { ReactNode } from "react"

// One-line definitions for the Budgets words a new builder meets first. The wizard and the
// Budgets page share them so a term means the same thing everywhere it appears.
export const BUDGET_TERMS = {
  "runtime key":
    "The API key your code spends with. It can create a budget and tighten a cap, never raise one.",
  "config key":
    "The API key that configures. Only it can raise or remove a cap, so keep it out of the code that spends.",
  "budget key":
    "The name you give one budget, like customer:acme or run:42. Each budget key has its own cap and balance.",
  estimate:
    "The most a call may cost. It is held against the cap before the call runs, then settled to the actual cost.",
  actual: "What the call really cost. It replaces the estimate, and the unused part is returned.",
  lease:
    "Capacity granted up front to a long-running process, so it can spend in memory and report usage later.",
} as const

export type BudgetTerm = keyof typeof BUDGET_TERMS

/** A term with its definition on hover or focus, marked with a dotted underline. */
export function Term({
  term,
  children,
  className,
}: {
  term: BudgetTerm
  children?: ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the definition must be reachable by keyboard
          tabIndex={0}
          className={cn(
            "cursor-help underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          {children ?? term}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-5">{BUDGET_TERMS[term]}</TooltipContent>
    </Tooltip>
  )
}

/** The same definitions as a short list, for a place where hover is not enough. */
export function TermList({ terms, className }: { terms: BudgetTerm[]; className?: string }) {
  return (
    <dl className={cn("grid gap-1.5 text-xs leading-5", className)}>
      {terms.map((term) => (
        <div key={term} className="flex flex-wrap gap-x-1.5">
          <dt className="font-medium font-mono text-background-textContrast">{term}</dt>
          <dd className="text-background-text">{BUDGET_TERMS[term]}</dd>
        </div>
      ))}
    </dl>
  )
}
