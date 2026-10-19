import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { InstallCommand } from "./budgets-hero"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The close: one decision inside the logo's bracket and the install line under
// it, nothing else. The terms are the home page's offer, stated once in the
// station fact.

const BRACKET_CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "right-0 bottom-0 border-r-2 border-b-2",
]

export function BudgetsCta() {
  return (
    <SectionShell
      labelledBy="budgets-cta-title"
      className="ledger-dots"
      innerClassName="flex flex-col items-center py-24 text-center sm:py-32"
    >
      <StationHeader index="06" label="Start" fact="free during early access · no card" />
      <h2
        id="budgets-cta-title"
        className="mt-6 max-w-3xl font-primary text-background-textContrast text-display-2"
      >
        <Balancer>Put a hard cap in front of your agent today.</Balancer>
      </h2>
      <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
        <Balancer>
          Create a key, install the package, and wrap one call. Nothing in your billing changes.
        </Balancer>
      </p>

      <div className="relative mt-12 px-6 py-5">
        {BRACKET_CORNERS.map((corner) => (
          <span
            key={corner}
            aria-hidden
            className={cn("absolute size-3 border-background-textContrast", corner)}
          />
        ))}
        <AcquisitionLink
          source="budgets_cta"
          intent="budgets"
          className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
        >
          Get an API key
        </AcquisitionLink>
      </div>

      <InstallCommand className="mt-6" />
    </SectionShell>
  )
}
