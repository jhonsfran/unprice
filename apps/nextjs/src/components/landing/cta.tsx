import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"
import { Reveal } from "./reveal"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The close is the offer. A pricing company that hides its own deal
// undermines its authority, so the deal ends the page in the same receipt
// grammar as the product — every fact true today: AGPL-3.0 core, free early
// access, no card at signup, funds settle to the builder's own Stripe. The
// bracket corners are the logo's containment motif around the one decision
// left on the page — the reader's.

export default function Cta() {
  return (
    <SectionShell
      labelledBy="cta-title"
      className="ledger-dots"
      innerClassName="flex flex-col items-center py-24 text-center sm:py-32"
    >
      <>
        <StationHeader index="05" label="The offer" fact="free to prove · yours to keep" />

        <h2
          id="cta-title"
          className="mt-6 max-w-3xl font-primary text-background-textContrast text-display-2"
        >
          <Balancer>The pricing is as explainable as yours will be.</Balancer>
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            The core is AGPL-3.0 and free to run in your own Cloudflare account. The hosted cloud
            is free during early access, with no card at signup. Payments settle to your own Stripe
            account either way — Unprice never sits in your funds flow.
          </Balancer>
        </p>
        <p className="mt-4 max-w-2xl text-background-text text-sm leading-6">
          <Balancer>
            The money path is yours to read, fork, and run — it cannot be acquired out from under
            you. The full argument is in{" "}
            <Link
              href="/manifesto"
              className="font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 hover:decoration-background-textContrast"
            >
              the manifesto
            </Link>
            .
          </Balancer>
        </p>

        <Reveal className="mt-12 w-full max-w-2xl rounded-lg border border-background-border bg-surface-panel p-5 text-left shadow-ambient sm:p-6">
          <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The walk-away guarantee
            </span>
            <span className="hidden font-mono text-[10px] text-background-text sm:inline">
              shadow · read-only · one line
            </span>
          </div>
          <p className="mt-3 text-background-text text-sm leading-6">
            Adopt in shadow: one read-only{" "}
            <code className="font-mono text-[12px]">access.check</code> beside the logic you already
            trust, blocking nothing. If the decisions never match your reality, delete that one line
            and walk away — nothing migrated, nothing to unwind, no contract to exit. Enforce only
            when the evidence convinces you.
          </p>
        </Reveal>

        <div className="relative mt-12 px-6 py-5">
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
          one paid action · one afternoon · free during early access · no card
        </p>

        <Reveal className="mt-24 w-full max-w-2xl rounded-lg border border-background-border bg-surface-panel p-5 text-left shadow-ambient sm:p-6">
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
        </Reveal>
      </>
    </SectionShell>
  )
}
