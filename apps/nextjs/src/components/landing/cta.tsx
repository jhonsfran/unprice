import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"

// The close is Sage, not Ruler: the hero promised control, the close promises
// understanding. The bracket corners are the logo's containment motif around
// the one decision left on the page — the reader's.

export default function Cta() {
  return (
    <section aria-labelledby="cta-title" className="w-full border-background-border border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <h2
          id="cta-title"
          className="max-w-3xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
        >
          <Balancer>
            Every allow, deny, charge, and credit — explained from one money path.
          </Balancer>
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            Pick one paid action, run the decision in shadow beside your current logic, and enforce
            only when the evidence convinces you.
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
          <Link
            href={`${APP_DOMAIN}`}
            className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
          >
            Start with one paid action
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>

        <p className="mt-4 font-mono text-[11px] text-background-text">
          free during early access · no card · AGPL-3.0 core
        </p>

        <div className="mt-40 w-full max-w-2xl rounded-lg border border-background-border bg-background-bgSubtle p-5 text-left sm:p-6">
          <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              Map my paid action
            </span>
            <span className="hidden font-mono text-[10px] text-background-text sm:inline">
              founder · replies personally
            </span>
          </div>
          <p className="mt-3 text-background-text text-sm leading-6">
            Not sure where to start? Tell me the action that burns margin when a customer runs it —
            an LLM call, a workflow, an API job — and what stops it today, if anything. I&apos;ll
            reply personally with a concrete first step: where to put the check, what to run in
            shadow beside what you already have, and whether to block each request or cap the whole
            job.
            <span className="mt-2 block font-medium text-background-textContrast">
              — Seb, founder of Unprice
            </span>
          </p>
          <div className="my-6">
            <a
              href="mailto:seb@unprice.dev?subject=What%20runs%20when%20customers%20overspend%3F"
              className={buttonVariants({ variant: "outline", className: "gap-1.5" })}
            >
              Email what runs
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
