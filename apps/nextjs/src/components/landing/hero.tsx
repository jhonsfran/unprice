import { buttonVariants } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"
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
          {/* Two-tone emphasis: the mechanism in muted text, the moment it
              happens in ink — the clause a burned engineer reads first. The
              whole product is a question of when, not what. */}
          <h1 id="hero-title" className="font-primary text-background-textContrast text-display-1">
            <Balancer>
              <span className="text-background-text">Authorize agent spend</span> before the
              provider call.
            </Balancer>
          </h1>
          {/* The h1 names the moment; the subhead names the loop, in the four
              words the runtime actually uses: reserve, run, settle, release.
              The second sentence is the claim nothing adjacent can make — a
              deny is not a slower request or a smaller charge, it is zero
              provider calls — paired with the artifact that proves it.

              "Customer money path" is canon and stays, but it is earned at
              station 02, directly above the diagram that defines it. Used here
              it collides with the funds boundary three rows below ("the money
              never touches Unprice"): a reader meeting the phrase cold parses
              it as Unprice sitting in the flow, which is the one misread that
              costs the most. */}
          <p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Reserve against the customer&apos;s budget, run the work, then settle what it actually
            cost and release the rest. A denied run makes zero provider calls and still leaves a
            receipt that says why.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <AcquisitionLink
              source="hero"
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Start with one agent action
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
              Settles to your own Stripe.{" "}
              <span className="font-normal text-background-text">
                The money never touches Unprice.
              </span>
            </p>
            {/* "nothing to deploy" is here because its absence cost a signup:
                the FAQ's "Do I need Cloudflare? Today, yes" read as a hard
                infrastructure gate on the hosted product too, and a reader on
                AWS bounced rather than ask. Cloudflare is the self-run path
                only. */}
            <p className="mt-2 font-mono text-[11px] text-background-text leading-5">
              AGPL-3.0 open source · EU-hosted · two calls to integrate · nothing to deploy
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
