import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { MoneyPath } from "./money-path"

// The first viewport enters at money altitude — the door of the house speaks
// founder, not code (marketing-framework.md). One center of gravity per
// column: the headline sells the gain, the compact money path demonstrates
// only the decision moment (request → price → budget check → allow/deny);
// the accounting — wallet, ledger, invoice, payment — lives at station 04,
// where the demo's footer points. Trust signals carry one dominant claim
// (the funds boundary) and one metadata line; the offer terms ride the CTA
// as microcopy instead of competing as a fourth fact.

// Placeholder until the scheduling link exists — the mailto keeps the button
// honest (it always works) and the swap is this one line.
const FOUNDER_CALL_URL = "mailto:seb@unprice.dev?subject=Call%20with%20the%20founder"

export default function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="ledger-dots mx-auto w-full max-w-6xl px-6 pt-12 pb-16 sm:pt-16 sm:pb-20 lg:pt-24"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex flex-col items-start">
          {/* Two-tone emphasis: the business model in text, the money gain in
              ink — the payoff clause is the one a margin owner reads first. */}
          <h1 id="hero-title" className="font-primary text-background-textContrast text-display-1">
            <Balancer>
              <span className="text-background-text">Sell credits and usage.</span> Keep the margin.
            </Balancer>
          </h1>
          <p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Approve or deny every paid action against plan, credits, and budget — before usage
            becomes cost.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <AcquisitionLink
              source="hero"
              pendingLabel="Opening signup…"
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Start with one paid action
              <ArrowRight aria-hidden className="size-3.5" />
            </AcquisitionLink>
            <a href={FOUNDER_CALL_URL} className={buttonVariants({ variant: "outline" })}>
              Book a call with the founder
            </a>
          </div>
          <p className="mt-3.5 font-mono text-[11px] text-background-text">
            free during early access · no card at signup
          </p>

          {/* One dominant trust signal — the funds boundary, the reason to
              believe "keep the margin" — then the rest as one metadata line. */}
          <div className="mt-12 w-full max-w-xl border-background-border border-t pt-6">
            <p className="font-medium text-background-textContrast text-base leading-7">
              Settles to your own Stripe
              <span className="font-normal text-background-text">
                {" "}
                — the money never touches Unprice.
              </span>
            </p>
            <p className="mt-2 font-mono text-[11px] text-background-text leading-5">
              AGPL-3.0 open source · two calls to integrate · shadow-first
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-background-border bg-surface-panel p-4 shadow-raised sm:p-6 lg:p-8">
          <MoneyPath variant="compact" />
        </div>
      </div>
    </section>
  )
}
