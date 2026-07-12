import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { MoneyPath } from "./money-path"

// The first viewport is the product truth: one request, one decision, both
// outcomes. Copy on the left states the wedge; the money path on the right
// shows it. The only motion is the request dot walking the path.

const heroFacts = [
  { label: "License", value: "AGPL-3.0 open source" },
  { label: "Access", value: "Free during early access" },
  { label: "Any Payment Provider", value: "Start with stripe now" },
  { label: "Custody", value: "Funds stay with you" },
]

export default function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="ledger-dots mx-auto w-full max-w-6xl px-6 pt-12 pb-16 sm:pt-16 sm:pb-20 lg:pt-20"
    >
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex flex-col items-start">
          {/* Two-tone emphasis: the setup in text, the payoff in ink. The
              operative clause carries the sentence — emphasis by precision,
              not decoration. */}
          <h1 id="hero-title" className="font-primary text-background-textContrast text-display-1">
            <Balancer>
              <span className="text-background-text">Authorize customer spend</span> before paid
              work runs.
            </Balancer>
          </h1>
          {/* Compression rule (strategic/positioning-and-messaging.md): one loss-framed
              sentence plus the category frame. The enumeration lives below the
              fold as state — the problem trace and the money-path stations. */}
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Sell credits and usage-based plans without eating over-budget customer work. Unprice is
            the open-source customer money path for usage-based SaaS.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <AcquisitionLink
              source="hero"
              pendingLabel="Opening signup…"
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Start with one paid action
              <ArrowRight aria-hidden className="size-3.5" />
            </AcquisitionLink>
          </div>

          <dl className="mt-10 grid w-full max-w-xl grid-cols-2 gap-x-6 gap-y-4 border-background-border border-t pt-5">
            {heroFacts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-background-text text-xs leading-5">{fact.label}</dt>
                <dd className="mt-0.5 font-medium text-background-textContrast text-sm leading-5">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-lg border border-background-border bg-surface-panel p-4 shadow-raised sm:p-6">
          <MoneyPath />
        </div>
      </div>
    </section>
  )
}
