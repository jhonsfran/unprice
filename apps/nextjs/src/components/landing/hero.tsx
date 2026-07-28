import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { hasDemoVideo } from "./demo-video"
import { MoneyPath } from "./money-path"
import { ProofLink } from "./proof-link"

export default function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="ledger-dots mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-6xl flex-col justify-center px-6 py-12"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex flex-col items-start">
          {/* Two-tone emphasis: the business model in muted text, the money
              payoff in ink — the clause a margin owner reads first. */}
          <h1 id="hero-title" className="font-primary text-background-textContrast text-display-1">
            <Balancer>
              <span className="text-background-text">Sell credits and usage.</span> Keep the margin.
            </Balancer>
          </h1>
          {/* The canonical mechanism sentence leads the subhead verbatim, so a
              reader who clicked the HN post, the <title> or the OG card lands
              on the string they clicked. Message-match needs the sentence
              recognized above the fold, not occupying the h1 — and a benefit
              reads better as a short declarative than as the negative clause
              it becomes when the mechanism takes the headline slot.

              Second sentence names three product shapes the avatar recognizes
              instead of the coined category. "Customer money path" is canon and
              stays — but it is earned at station 02, directly above the diagram
              that defines it. Used here it also collides with the funds
              boundary three rows below ("the money never touches Unprice"): a
              reader meeting the phrase cold parses it as Unprice sitting in the
              flow, which is the one misread that costs the most. */}
          <p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Authorize customer spend before paid work runs — what your customers spend, not your own
            provider bill. Open source, for SaaS that sells credits, API calls, or agent runs.
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
            {/* Label follows the artifact. Offering to play a recording that
                does not exist yet is the fastest way to read as a shell — and
                it was, to every reader who clicked it. */}
            <ProofLink
              source="hero_demo"
              href="#demo"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              {hasDemoVideo ? "Watch it deny a request" : "See the receipts"}
            </ProofLink>
          </div>
          <p className="mt-3.5 font-mono text-[11px] text-background-text">
            free during early access · no card at signup
          </p>

          {/* One dominant trust signal — the funds boundary, the reason to
              believe the promise — then the rest as one metadata line. */}
          <div className="mt-12 w-full max-w-xl border-background-border border-t pt-6">
            <p className="font-medium text-background-textContrast text-base leading-7">
              Settles to your own Stripe
              <span className="font-normal text-background-text">
                {" "}
                — the money never touches Unprice.
              </span>
            </p>
            {/* "nothing to deploy" is here because its absence cost a signup:
                the FAQ's "Do I need Cloudflare? Today, yes" read as a hard
                infrastructure gate on the hosted product too, and a reader on
                AWS bounced rather than ask. Cloudflare is the self-run path
                only. */}
            <p className="mt-2 font-mono text-[11px] text-background-text leading-5">
              AGPL-3.0 open source · two calls to integrate · nothing to deploy
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
