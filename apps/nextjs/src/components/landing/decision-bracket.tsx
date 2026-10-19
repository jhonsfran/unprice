import { cn } from "@unprice/ui/utils"
import type { ReactNode } from "react"

// The logo's containment motif marks the decision moment.
const BRACKET_CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "right-0 bottom-0 border-r-2 border-b-2",
]

/** The close's one decision, inside the logo's bracket corners. */
export function DecisionBracket({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("relative px-6 py-5", className)}>
      {BRACKET_CORNERS.map((corner) => (
        <span
          key={corner}
          aria-hidden
          className={cn("absolute size-3 border-background-textContrast", corner)}
        />
      ))}
      {children}
    </div>
  )
}
