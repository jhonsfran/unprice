import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"

// The close: belief stated as three refusals, then the invitation. Same
// bracket-corner containment motif as the landing close — one decision left
// on the page, the reader's.

const refusals = [
  "You shouldn't need a deployment to change a price.",
  "You shouldn't discover an over-budget customer at invoice time.",
  "You shouldn't reconstruct a disputed charge by hand.",
]

export default function ManifestoBelief() {
  return (
    <section
      aria-labelledby="belief-title"
      className="ledger-dots w-full border-background-border border-t"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <h2
          id="belief-title"
          className="max-w-3xl font-primary text-background-textContrast text-display-2"
        >
          <Balancer>The team that owns the request path should own pricing.</Balancer>
        </h2>

        <ul className="mt-8 flex flex-col gap-2">
          {refusals.map((line) => (
            <li key={line} className="text-background-text text-base leading-7 sm:text-lg">
              {line}
            </li>
          ))}
        </ul>

        <p className="mt-8 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            For usage-based SaaS, pricing is a runtime decision. Unprice keeps that decision in open
            code you can run and inspect.
          </Balancer>
        </p>

        <div className="relative mt-10 px-6 py-5">
          <span
            aria-hidden
            className="absolute top-0 left-0 size-3 border-background-textContrast border-t-2 border-l-2"
          />
          <span
            aria-hidden
            className="absolute top-0 right-0 size-3 border-background-textContrast border-t-2 border-r-2"
          />
          <span
            aria-hidden
            className="absolute bottom-0 left-0 size-3 border-background-textContrast border-b-2 border-l-2"
          />
          <span
            aria-hidden
            className="absolute right-0 bottom-0 size-3 border-background-textContrast border-r-2 border-b-2"
          />
          <AcquisitionLink
            source="manifesto"
            pendingLabel="Opening signup…"
            className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
          >
            Start with one paid action
            <ArrowRight aria-hidden className="size-3.5" />
          </AcquisitionLink>
        </div>
      </div>
    </section>
  )
}
