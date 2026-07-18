import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { Reveal } from "./reveal"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The close is the offer, and it ends the page in one arc: the deal in one
// short paragraph, the one decision inside the bracket corners, the receipt
// of what the afternoon actually is (one plan version, one customer signup,
// one shadow check — the signup step is stated, not hidden), and one ruled
// strip where the walk-away guarantee and the founder letter are the same
// thing: the terms are Seb's promise, signed. Every fact true today:
// AGPL-3.0 core, free early access, no card at signup, funds settle to the
// builder's own Stripe.

export default function Cta() {
  return (
    <SectionShell
      labelledBy="cta-title"
      className="ledger-dots"
      innerClassName="flex flex-col items-center py-24 text-center sm:py-32"
    >
      <>
        <StationHeader index="08" label="The offer" fact="AGPL-3.0 core · no card at signup" />

        <h2
          id="cta-title"
          className="mt-6 max-w-3xl font-primary text-background-textContrast text-display-2"
        >
          <Balancer>Free to prove. Yours to keep.</Balancer>
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            The core is AGPL-3.0, free to run in your own Cloudflare account; the hosted cloud is
            free during early access, no card at signup. Either way, payments settle to your own
            Stripe — the full argument is in{" "}
            <Link
              href="/manifesto"
              className="font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 hover:decoration-background-textContrast"
            >
              the manifesto
            </Link>
            .
          </Balancer>
        </p>

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
          <AcquisitionLink
            source="closing_cta"
            pendingLabel="Opening signup…"
            className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
          >
            Start with one paid action
            <ArrowRight aria-hidden className="size-3.5" />
          </AcquisitionLink>
        </div>

        {/* The afternoon, itemized honestly: the signup step is part of the
            deal, so it is part of the receipt. */}
        <p className="mt-5 font-mono text-[11px] text-background-text leading-5">
          <span className="whitespace-nowrap">one plan version</span> ·{" "}
          <span className="whitespace-nowrap">one customer signup</span> ·{" "}
          <span className="whitespace-nowrap">one shadow check</span>
        </p>
        <p className="mt-1 font-mono text-[11px] text-background-text leading-5">
          <span className="whitespace-nowrap">one afternoon</span> ·{" "}
          <span className="whitespace-nowrap">free during early access</span> ·{" "}
          <span className="whitespace-nowrap">no card</span>
        </p>

        {/* The guarantee and the founder letter are one block: the walk-away
            terms are Seb's promise, so they carry his signature and his
            inbox — mono strip header, human prose, signed. */}
        <Reveal className="mt-16 w-full max-w-2xl border-background-border border-y py-6 text-left">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The walk-away guarantee
            </span>
            <span className="hidden font-mono text-[10px] text-background-text sm:inline">
              shadow · read-only · nothing blocked
            </span>
          </div>
          <p className="mt-3 text-background-text text-sm leading-6">
            Sign up one test customer and run one read-only{" "}
            <code className="font-mono text-[12px]">access.check</code> beside the logic you already
            trust — blocking nothing. If the decisions don&apos;t match your reality, delete that
            line and walk away: nothing in your stack changed, no card, no contract.
          </p>
          <p className="mt-4 text-background-text text-sm leading-6">
            Not sure where the check goes? Tell me the action that burns margin when a customer runs
            it, and I&apos;ll reply personally with the first step.
          </p>
          <p className="mt-4 font-medium text-background-textContrast text-sm leading-6">
            — Seb, founder of Unprice
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <a
              href="mailto:seb@unprice.dev?subject=What%20runs%20when%20customers%20overspend%3F"
              className={buttonVariants({ variant: "outline", className: "gap-1.5" })}
            >
              Email what runs
            </a>
            <span className="font-mono text-[11px] text-background-text">
              seb@unprice.dev · replies personally
            </span>
          </div>
        </Reveal>
      </>
    </SectionShell>
  )
}
