import type { StationDotVariant } from "@unprice/ui/station"
import { cn } from "@unprice/ui/utils"
import { Reveal } from "./reveal"
import { Leader, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// Station 02 — the hidden objection: "my gateway already has a cap". The
// claim stays inside what every gateway cap does (it caps the bill of the key
// it sits on); some gateways also budget per customer, so the page never says
// otherwise. The two panels render the same night under each cap: one shared
// provider-key cap trips for every customer, a budget per key stops only the
// runaway. Amber marks the one decision — acme stopped at its own cap.

type Row = {
  key: string
  fact: string
  dot: StationDotVariant
  tone?: "danger" | "decision"
}

const sharedCap: Row[] = [
  { key: "customer:acme", fact: "runaway agent", dot: "default" },
  { key: "customer:globex", fact: "refused", dot: "ghost", tone: "danger" },
  { key: "customer:initech", fact: "refused", dot: "ghost", tone: "danger" },
  { key: "customer:umbrella", fact: "refused", dot: "ghost", tone: "danger" },
]

const perKey: Row[] = [
  { key: "customer:acme", fact: "$50.00 of $50 · 402", dot: "default", tone: "decision" },
  { key: "customer:globex", fact: "$12.40 of $50 · running", dot: "live" },
  { key: "customer:initech", fact: "$3.10 of $20 · running", dot: "live" },
  { key: "customer:umbrella", fact: "$31.75 of $50 · running", dot: "live" },
]

function CapPanel({
  title,
  caption,
  rows,
  outcome,
  outcomeTone,
  lifted = false,
}: {
  title: string
  caption: string
  rows: Row[]
  outcome: { label: string; fact: string }
  outcomeTone: "danger" | "decision"
  lifted?: boolean
}) {
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-background-border p-4 sm:p-5",
        lifted ? "bg-surface-raised shadow-raised" : "bg-surface-panel shadow-ambient"
      )}
    >
      <figcaption className="mb-3 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          {title}
        </span>
        <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
          {caption}
        </span>
      </figcaption>
      <Reveal stagger className="flex flex-col">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline gap-2 py-[5px]">
            <StationDot variant={row.dot} className="self-center" />
            <span
              className={cn(
                "font-mono text-xs",
                row.dot === "ghost" ? "text-background-text" : "text-background-textContrast"
              )}
            >
              {row.key}
            </span>
            <Leader />
            <span
              className={cn(
                "whitespace-nowrap font-mono text-[11px]",
                row.tone === "danger" && "text-danger-text",
                row.tone === "decision" && "font-medium text-primary-text",
                !row.tone && "text-background-text"
              )}
            >
              {row.fact}
            </span>
          </div>
        ))}
      </Reveal>
      <div className="mt-auto flex items-baseline gap-2 border-background-border border-t pt-3">
        <span className="text-background-textContrast text-sm">{outcome.label}</span>
        <Leader />
        <span
          className={cn(
            "whitespace-nowrap font-medium font-mono text-[11px]",
            outcomeTone === "danger" ? "text-danger-text" : "text-background-textContrast"
          )}
        >
          {outcome.fact}
        </span>
      </div>
    </figure>
  )
}

export function BudgetsPerKey() {
  return (
    <SectionShell labelledBy="budgets-per-key-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="02" label="Per key" fact="every key you pick" />
        <h2
          id="budgets-per-key-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Your gateway caps your provider bill. Budgets cap every key you pick.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          When every customer shares one provider key, one runaway agent trips the cap for all of
          them. A budget sits on the key the cap is about: a customer, a run, an agent, or an API
          key you issued.
        </p>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 md:gap-6">
        <CapPanel
          title="One cap"
          caption="on the provider key"
          rows={sharedCap}
          outcome={{ label: "the cap trips", fact: "every customer refused" }}
          outcomeTone="danger"
        />
        <CapPanel
          title="A budget per key"
          caption="hard caps · per customer"
          rows={perKey}
          outcome={{ label: "the runaway", fact: "stopped at its own cap" }}
          outcomeTone="decision"
          lifted
        />
      </div>
    </SectionShell>
  )
}
