import { cn } from "@unprice/ui/utils"
import { Reveal } from "./reveal"
import { Leader, LedgerRow, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// Station 01 — the incident first: the over-budget night from the launch
// video, as a trace. The alert arrives on time and is still useless, because
// it reports spend that already happened. The ghost rows are what never ran
// before each call. Same fictional universe as the home page ($1,204 against a
// $500 budget), so the two pages tell one story.

const night = [
  { time: "23:04", event: "run:r_42 started", fact: "research agent" },
  { time: "23:04 →", event: "model calls", fact: "never stopped" },
  { time: "07:58", event: "usage alert", fact: "over the $500 budget" },
]

const neverRan = [
  { label: "check before each call", fact: "never ran", emphasis: true },
  { label: "cap on run:r_42", fact: "none" },
]

export function BudgetsProblem() {
  return (
    <SectionShell labelledBy="budgets-problem-title">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader index="01" label="Too late" fact="alert · after the spend" />
          <h2
            id="budgets-problem-title"
            className="mt-6 max-w-xl font-primary text-background-textContrast text-display-3"
          >
            Billing is too late.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            <span className="text-background-textContrast">An alert is not a cap.</span> By the time
            it arrives, the money is spent.
          </p>
        </div>

        <figure
          aria-label="A trace of one overnight agent run. The run starts at 23:04 and its model calls never stop. At 07:58 the usage alert reports spend over the $500 budget, by which point $1,204 is spent. No check ran before any call, and the run had no cap."
          className="h-fit rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient sm:p-5"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The night
            </span>
            <span className="font-mono text-[10px] text-background-text">
              one agent run · traced
            </span>
          </figcaption>

          <Reveal stagger className="flex flex-col">
            {night.map((row) => (
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
          </Reveal>

          <div className="mt-3 border-background-border border-t pt-2">
            <LedgerRow
              label="spent when the alert arrived"
              fact="$1,204.00"
              factClassName="font-medium text-background-textContrast"
            />
          </div>

          <div aria-hidden className="relative mt-3 py-1.5">
            <span className="-translate-y-1/2 absolute top-1/2 left-0 h-px w-3 bg-background-border" />
            <span className="pl-6 font-mono text-[10px] text-background-text uppercase tracking-widest">
              what ran before each call
            </span>
          </div>

          <div className="flex flex-col">
            {neverRan.map((row) => (
              <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
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
        </figure>
      </div>
    </SectionShell>
  )
}
