import { LedgerRow, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// The status quo, rendered as state: a trace of the DIY stack (Stripe + a
// usage table + a Redis counter + cron) where the paid work runs first and
// the evidence never exists. The ghost grammar from the money path — absence
// as proof — applied to the buyer's current system.

const traceEvents = [
  { time: "09:41:02", event: "POST /v1/run", fact: "200 · work executed" },
  { time: "09:41:02", event: "INCR usage:acme-corp", fact: "4,101 → 4,102" },
  { time: "09:41:03", event: "provider cost", fact: "$0.48 · already spent" },
]

const missingEvidence = [
  { label: "plan version", fact: "unknown" },
  { label: "entitlement check", fact: "never ran" },
  { label: "budget check", fact: "never ran" },
  { label: "credits reserved", fact: "none" },
  { label: "ledger entry", fact: "no entry" },
]

export function ProblemSection() {
  return (
    <SectionShell labelledBy="problem-title">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader label="The status quo" fact="budget check · never ran" />
          <h2
            id="problem-title"
            className="mt-6 max-w-xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
          >
            By invoice time, the paid work already ran.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            A customer triggers the expensive action. Your counter notices later. Your invoice
            explains it weeks later. If the request should have been blocked, the cost is already
            real; if the customer disputes it, engineering turns into invoice support.
          </p>

          <div className="mt-10 max-w-xl border-background-border border-t pt-6">
            <h3 className="font-medium text-background-textContrast text-lg">
              Your Redis counter is not a budget.
            </h3>
            <p className="mt-3 text-background-text text-sm leading-6">
              A counter can say usage is high. It cannot prove which plan version applied, which
              credits were reserved, why a request was denied, and how accepted usage became an
              invoice line. The counter and the real cost live in different systems, so budgets
              drift from spend — and every packaging change edits product code, billing scripts, and
              reconciliation jobs at once.
            </p>
          </div>
        </div>

        <figure
          aria-label="A trace of the DIY stack: the paid work executes and creates cost, but when the customer disputes the invoice, the plan version is unknown, no entitlement or budget check ever ran, no credits were reserved, and there is no ledger entry — the evidence has to be reconstructed from logs by hand."
          className="h-fit rounded-lg border border-background-border bg-background-bgSubtle p-4 sm:p-5"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The DIY stack
            </span>
            <span className="font-mono text-[10px] text-background-text">
              one paid action · traced
            </span>
          </figcaption>

          <div className="flex flex-col">
            {traceEvents.map((row) => (
              <div key={row.event} className="flex items-baseline gap-2 py-[5px]">
                <span className="hidden w-16 shrink-0 font-mono text-[11px] text-background-text sm:inline">
                  {row.time}
                </span>
                <span className="font-medium font-mono text-background-textContrast text-xs">
                  {row.event}
                </span>
                <span
                  aria-hidden
                  className="mx-1 min-w-4 flex-1 self-center border-background-border border-b border-dotted"
                />
                <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
                  {row.fact}
                </span>
              </div>
            ))}
          </div>

          <div aria-hidden className="relative my-3 py-1.5">
            <span className="-translate-y-1/2 absolute top-1/2 left-0 h-px w-3 bg-background-border" />
            <span className="pl-6 font-mono text-[10px] text-background-text uppercase tracking-widest">
              the customer disputes the invoice
            </span>
          </div>

          <div className="flex flex-col">
            {missingEvidence.map((row) => (
              <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
                <StationDot variant="ghost" className="self-center" />
                <span className="text-background-text text-sm">{row.label}</span>
                <span
                  aria-hidden
                  className="mx-1 min-w-4 flex-1 self-center border-background-border border-b border-dotted"
                />
                <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
                  {row.fact}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 border-background-border border-t pt-3">
            <LedgerRow label="30 days later · invoice line" fact="$1,204.00" />
            <LedgerRow
              label="evidence"
              variant="ghost"
              fact="reconstructed from logs · by hand"
              factClassName="text-danger-text"
            />
          </div>
        </figure>
      </div>
    </SectionShell>
  )
}
