import { buttonVariants } from "@unprice/ui/button"
import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import { Reveal } from "./reveal"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The close is one decision and one signature. Nothing else.
//
// It used to argue the integration three times inside one viewport — the
// subhead narrated signUp → check, the guarantee narrated it again, and the
// strip's fact line repeated station 04's shadow ledger verbatim — then
// stacked seven micro-facts under the button and put a second button beside
// the primary one (distill pass 2026-07-27). Station 04 owns the integration
// and station 05 owns the objections. By the time a reader is here the
// argument is over; the close only has to name the prerequisite, hold the
// decision, and be signed.
//
// So every fact is stated exactly once, in the one place it decides
// something: the terms of entry in the header, the afternoon on the receipt
// under the button, and what makes leaving free in the signed strip. AGPL-3.0
// is the hero's fact and the footer's license row, not a third echo here.
//
// The one mailto is the only other way out of this section, and it is inside
// the founder's own sentence — a person to answer, not a competing CTA.

// The logo's containment motif marks the decision moment.
const BRACKET_CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "right-0 bottom-0 border-r-2 border-b-2",
]

const inlineLink = cn(
  "rounded-sm font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 transition-colors duration-quick ease-out-quad hover:decoration-background-textContrast",
  focusRing
)

export default function Cta() {
  return (
    <SectionShell
      labelledBy="cta-title"
      className="ledger-dots"
      innerClassName="flex flex-col items-center py-24 text-center sm:py-32"
    >
      <>
        <StationHeader index="06" label="The offer" fact="free during early access · no card" />

        {/* The close sells the outcome and the time-box, not the price. */}
        <h2
          id="cta-title"
          className="mt-6 max-w-3xl font-primary text-background-textContrast text-display-2"
        >
          <Balancer>Start with one paid action in one afternoon.</Balancer>
        </h2>
        {/* One prerequisite, one exit to the long argument. */}
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            Bring the one action in your product that burns margin when a customer runs it. That is
            the only prerequisite. Read the argument in{" "}
            <Link href="/manifesto" className={inlineLink}>
              the manifesto
            </Link>
            .
          </Balancer>
        </p>

        <div className="relative mt-12 px-6 py-5">
          {BRACKET_CORNERS.map((corner) => (
            <span
              key={corner}
              aria-hidden
              className={cn("absolute size-3 border-background-textContrast", corner)}
            />
          ))}
          <AcquisitionLink
            source="closing_cta"
            pendingLabel="Opening signup…"
            className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
          >
            Start with one paid action
            <ArrowRight aria-hidden className="size-3.5" />
          </AcquisitionLink>
        </div>

        {/* The afternoon, itemized honestly: the customer-signup step is part
            of the deal, so it stays on the receipt. */}
        <p className="mt-5 font-mono text-[11px] text-background-text leading-5">
          <span className="whitespace-nowrap">one plan version</span> ·{" "}
          <span className="whitespace-nowrap">one customer signup</span> ·{" "}
          <span className="whitespace-nowrap">one shadow check</span>
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
              delete one line · nothing changed
            </span>
          </div>
          <p className="mt-3 text-background-text text-sm leading-6">
            If the decisions don&apos;t match your reality, delete the{" "}
            <code className="font-mono text-[12px]">access.check</code> line and walk away. Nothing
            in your stack changed, and there is no contract to exit.
          </p>
          {/* Honest scarcity: a real constraint on my own time, stated as a
              number. No countdown, no fake stock (marketing-framework.md). */}
          <p className="mt-4 text-background-text text-sm leading-6">
            I am taking ten design partners and I onboard each one myself.{" "}
            <a
              href="mailto:seb@unprice.dev?subject=What%20runs%20when%20customers%20overspend%3F"
              className={inlineLink}
            >
              Email me your action
            </a>{" "}
            and I&apos;ll reply with the first step, even if no slot is left.
          </p>
          <p className="mt-4 font-medium text-background-textContrast text-sm leading-6">
            Seb, founder of Unprice · <span className="font-mono text-xs">seb@unprice.dev</span>
          </p>
        </Reveal>
      </>
    </SectionShell>
  )
}
