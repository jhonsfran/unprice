import { APP_DOMAIN, DOCS_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { GitHub } from "@unprice/ui/icons"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"
import { MoneyPath } from "./money-path"

// The first viewport is the product truth: one request, one decision, both
// outcomes. Copy on the left states the wedge; the money path on the right
// shows it. The only motion is the request dot walking the path.

const heroFacts = ["AGPL-3.0 core", "your own Stripe", "never in your funds flow"]

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
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Unprice is the open-source customer money path for usage-based SaaS. Keep plans
            versioned, entitlements separate, customer budgets in the request path, and invoice
            evidence tied to the same decision that allowed or denied the work.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={`${APP_DOMAIN}`}
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Start with one paid action
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
            <Link
              href="https://github.com/jhonsfran1165/unprice"
              target="_blank"
              className={buttonVariants({ variant: "outline", className: "gap-2" })}
            >
              <GitHub aria-hidden className="size-4" />
              Star on GitHub
            </Link>
            <Link
              href={`${DOCS_DOMAIN}`}
              target="_blank"
              className={buttonVariants({ variant: "ghost" })}
            >
              Explore the SDK
            </Link>
          </div>

          <ul className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-background-border border-t pt-4">
            {heroFacts.map((fact, index) => (
              <li
                key={fact}
                className="flex items-center gap-x-3 font-mono text-[11px] text-background-text"
              >
                {index > 0 && (
                  <span aria-hidden className="text-background-border">
                    ·
                  </span>
                )}
                {fact}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-background-border bg-background-bgSubtle p-4 sm:p-6">
          <MoneyPath />
        </div>
      </div>
    </section>
  )
}
