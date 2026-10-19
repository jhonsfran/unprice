import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { ProofLink } from "./proof-link"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 04 — the two latency modes. The headline is the launch video's line;
// the panels state the fact behind it without a millisecond figure that
// depends on the reader's machine: a local check makes no network call at
// all, and a remote check makes one. Both hold the same cap, because a lease
// is debited from the budget before the process spends it.

const REPO_URL = "https://github.com/jhonsfran1165/unprice"
const BENCHMARK_URL = `${REPO_URL}/blob/main/tooling/k6/budget-local.ts`

type Mode = {
  title: string
  caption: string
  count: string
  unit: string
  rows: { label: string; fact: string }[]
  call: string
}

const modes: Mode[] = [
  {
    title: "Local mode",
    caption: "long-lived processes",
    count: "0",
    unit: "network calls per check",
    rows: [
      { label: "answered from", fact: "a lease in memory" },
      { label: "use it in", fact: "servers · workers · agent runners" },
      { label: "reports", fact: "once a second" },
    ],
    call: 'budget(key, { mode: "local", lease: { amount: "5" } })',
  },
  {
    title: "Remote",
    caption: "the default",
    count: "1",
    unit: "network round trip per check",
    rows: [
      { label: "answered by", fact: "the budget" },
      { label: "use it in", fact: "serverless · edge · jobs" },
      { label: "if Unprice is down", fact: "new work is denied" },
    ],
    call: "budget(key)",
  },
]

export function BudgetsChecks() {
  return (
    <SectionShell labelledBy="budgets-checks-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="04" label="Checks" fact="local or remote" />
        <h2
          id="budgets-checks-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Zero-millisecond checks. Or one hop away.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          A long-lived process spends from a lease held in its own memory, so a check never leaves
          the process. Remote checks add one network round trip. Both hold the same hard cap.
        </p>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 md:gap-6">
        {modes.map((mode) => (
          <figure
            key={mode.title}
            className="flex min-w-0 flex-col rounded-lg border border-background-border bg-surface-raised p-4 shadow-ambient sm:p-5"
          >
            <figcaption className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
              <span className="font-mono text-background-text text-xs uppercase tracking-widest">
                {mode.title}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                {mode.caption}
              </span>
            </figcaption>
            <div className="flex items-baseline gap-3 py-6">
              <span className="font-primary text-background-textContrast text-display-2 tabular-nums">
                {mode.count}
              </span>
              <span className="text-background-text text-sm">{mode.unit}</span>
            </div>
            <div className="flex flex-col border-background-border border-t pt-2">
              {mode.rows.map((row) => (
                <LedgerRow key={row.label} label={row.label} variant="ghost" fact={row.fact} />
              ))}
            </div>
            <code className="mt-4 block overflow-x-auto whitespace-nowrap rounded-sm bg-background-bg px-2 py-1.5 font-mono text-[12px] text-background-textContrast">
              {mode.call}
            </code>
          </figure>
        ))}
      </div>

      <div className="mt-8 flex max-w-3xl flex-wrap items-baseline gap-x-4 gap-y-2">
        <p className="text-background-text text-sm leading-6">
          A lease is debited from the budget before the process spends it, so local spending never
          exceeds what the budget granted.
        </p>
        <ProofLink
          source="budgets_benchmark"
          href={BENCHMARK_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "group inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-sm font-medium text-background-textContrast text-sm",
            focusRing
          )}
        >
          Run the latency benchmark
          <ArrowRight
            aria-hidden
            className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
          />
        </ProofLink>
      </div>
    </SectionShell>
  )
}
