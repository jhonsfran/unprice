import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"
import { MoneyPath } from "./money-path"

// The first viewport is the product truth: one request, one decision, both
// outcomes. Copy on the left states the wedge; the money path on the right
// shows it. The only motion is the request dot walking the path.

const heroFacts = [
  { label: "License", value: "AGPL-3.0 open source" },
  { label: "Access", value: "Free during early access" },
  { label: "Payments", value: "Your Stripe account" },
  { label: "Custody", value: "Funds stay with you" },
]

export default function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="mx-auto w-full max-w-6xl px-6 pt-12 pb-16 sm:pt-16 sm:pb-20 lg:pt-20"
    >
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex flex-col items-start">
          <h1
            id="hero-title"
            className="font-primary font-semibold text-4xl text-background-textContrast leading-[1.08] tracking-tight sm:text-5xl sm:leading-[1.06]"
          >
            <Balancer>Authorize customer spend before paid work runs.</Balancer>
          </h1>
          {/* Compression rule (positioning-and-messaging.md): one loss-framed
              sentence plus the category frame. The enumeration lives below the
              fold as state — the problem trace and the money-path stations. */}
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Sell credits and usage-based plans without eating over-budget customer work. Unprice is
            the open-source customer money path for usage-based SaaS.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={`${APP_DOMAIN}`}
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Start with one paid action
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
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

        <div className="rounded-lg border border-background-border bg-background-bgSubtle p-4 sm:p-6">
          <MoneyPath />
        </div>
      </div>
    </section>
  )
}
