import { cn } from "@unprice/ui/utils"
import { Reveal } from "./reveal"
import { Leader, LedgerRow, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// Station 01 — the page opens with the pain (2026-07-18 critique: tension
// before release). The status quo, rendered as state: a trace of the DIY
// stack (Stripe + a usage table + a Redis counter + cron) where the paid
// work runs first and the evidence never exists. The ghost grammar from the
// money path — absence as proof — applied to the buyer's current system. The
// dispute moment is a literal artifact (a support ticket assigned to
// engineering), not a label: render the pain as artifacts
// (design-system-guidelines.md). The lower half is deliberately sparse so
// the eye lands on three things: the ticket, the $1,204 line, and "budget
// check · never ran".

const traceEvents = [
  { time: "03:00:07", event: "cron reset-usage", fact: "last success · 3d ago" },
  { time: "09:41:02", event: "POST /v1/run", fact: "200 · work executed" },
  { time: "09:41:02", event: "INCR usage:acme-corp", fact: "4,101 → 4,102" },
  { time: "09:41:03", event: "provider cost", fact: "$0.48 · already spent" },
]

// Three ghosts, not five: the plan terms, the one check that mattered, and
// the record that should have existed. Entitlement/credits rows cut — they
// restated the same absence and buried the landing point.
const missingEvidence = [
  { label: "plan version", fact: "unknown" },
  { label: "budget check", fact: "never ran", emphasis: true },
  { label: "ledger", fact: "no entry" },
]

export function ProblemSection() {
  return (
    <SectionShell labelledBy="problem-title">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader index="01" label="The status quo" fact="budget check · never ran" />
          <h2
            id="problem-title"
            className="mt-6 max-w-xl font-primary text-background-textContrast text-display-3"
          >
            By invoice time, the paid work already ran.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            <span className="text-background-textContrast">
              Your Redis counter is not a budget.
            </span>{" "}
            It notices usage after the expensive action already ran, and when the customer disputes
            the invoice, engineering reconstructs the charge from logs by hand.
          </p>
        </div>

        <figure
          aria-label="A trace of the DIY stack: the usage-reset cron last succeeded three days ago, the paid work executes and creates cost, and thirty days later the invoice bills $1,204. The customer opens a support ticket disputing the charge against their $500 budget and it is assigned to engineering — but the plan version is unknown, no entitlement or budget check ever ran, no credits were reserved, and there is no ledger entry. The evidence has to be reconstructed from logs by hand."
          className="h-fit rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient sm:p-5"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The DIY stack
            </span>
            <span className="font-mono text-[10px] text-background-text">
              one paid action · traced
            </span>
          </figcaption>

          <Reveal stagger className="flex flex-col">
            {traceEvents.map((row) => (
              <div key={row.event} className="flex items-baseline gap-2 py-[5px]">
                <span className="hidden w-16 shrink-0 font-mono text-[11px] text-background-text sm:inline">
                  {row.time}
                </span>
                <span className="font-medium font-mono text-background-textContrast text-xs">
                  {row.event}
                </span>
                <Leader />
                <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
                  {row.fact}
                </span>
              </div>
            ))}
            {/* the log keeps going where nobody indexed it — the ledger
                continues off the page */}
            <div className="flex items-baseline gap-2 py-[5px]">
              <span className="hidden w-16 shrink-0 font-mono text-[11px] text-background-text sm:inline">
                ⋯
              </span>
              <span className="font-mono text-[11px] text-background-text italic">
                38 more log lines · unindexed
              </span>
            </div>
          </Reveal>

          <div className="mt-3 border-background-border border-t pt-2">
            <LedgerRow
              label="30 days later · invoice line"
              fact="$1,204.00"
              factClassName="font-medium text-background-textContrast"
            />
          </div>

          {/* the dispute, as the artifact it actually arrives as — carrying
              the danger tier the deny grammar uses elsewhere on the page.
              This card is the section's center of gravity: the quote reads
              at body size, everything around it stays metadata. */}
          <div className="my-3 rounded-sm border border-danger-line bg-danger-bgSubtle px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                support · ticket #4812
              </span>
              <span className="font-mono text-[10px] text-background-text">reply due · 24h</span>
            </div>
            <p className="mt-2 text-background-textContrast text-base leading-7">
              “Why were we charged $1,204? We set a $500 budget.”
            </p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                assigned
              </span>
              <Leader />
              <span className="font-mono text-[10px] text-danger-text">engineering</span>
            </div>
          </div>

          <div aria-hidden className="relative py-1.5">
            <span className="-translate-y-1/2 absolute top-1/2 left-0 h-px w-3 bg-background-border" />
            <span className="pl-6 font-mono text-[10px] text-background-text uppercase tracking-widest">
              what engineering can pull up
            </span>
          </div>

          <div className="flex flex-col">
            {missingEvidence.map((row) => (
              <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
                {/* the dot stays a ghost even when emphasized — solid means
                    "ran" everywhere on this page; the absence is the danger */}
                <StationDot variant="ghost" className="self-center" />
                <span className="text-background-text text-sm">{row.label}</span>
                <Leader />
                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-[11px]",
                    row.emphasis ? "font-medium text-danger-text" : "text-background-text"
                  )}
                >
                  {row.fact}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 border-background-border border-t pt-3">
            <LedgerRow
              label="evidence"
              variant="ghost"
              fact="reconstructed by hand"
              factClassName="text-danger-text"
            />
          </div>
        </figure>
      </div>
    </SectionShell>
  )
}
