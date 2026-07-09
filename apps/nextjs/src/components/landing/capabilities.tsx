import { DOCS_DOMAIN } from "@unprice/config"
import { cn } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import type { ReactNode } from "react"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Capabilities, shown as specimens of real product state instead of feature
// cards: a plan-version ledger, a meter configuration, a budgeted run, an
// invoice line with its explain trail. If a capability can't be shown as
// state, it doesn't belong here.

function Specimen({
  caption,
  fact,
  children,
}: {
  caption: string
  fact: string
  children: ReactNode
}) {
  return (
    <div className="h-fit rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          {caption}
        </span>
        <span className="hidden font-mono text-[10px] text-background-text sm:inline">{fact}</span>
      </div>
      {children}
    </div>
  )
}

function VersionRow({
  version,
  status,
  customers,
  current,
}: {
  version: string
  status: string
  customers: string
  current?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2 py-[5px]">
      <span
        className={cn(
          "font-mono text-xs",
          current ? "font-medium text-background-textContrast" : "text-background-text"
        )}
      >
        {version}
      </span>
      <span
        aria-hidden
        className="mx-1 min-w-4 flex-1 self-center border-background-border border-b border-dotted"
      />
      <span className="text-right font-mono text-[11px] text-background-text leading-5">
        {customers} · {status}
      </span>
    </div>
  )
}

const capabilities = [
  {
    title: "Versioned plans",
    body: "Pin customers to the plan version they bought while new packaging ships safely. Pricing experiments never silently move existing customers.",
    specimen: (
      <Specimen caption="Plan versions" fact="plan: pro">
        <VersionRow version="pro@v2" status="pinned" customers="148 customers" />
        <VersionRow version="pro@v3" status="published" customers="12 customers" current />
        <VersionRow version="pro@v4" status="draft · ships to new signups" customers="0" />
        <p className="mt-3 border-background-border border-t pt-3 text-background-text text-xs leading-5">
          <span className="font-mono">acme-corp</span> stays on{" "}
          <span className="font-mono">pro@v2</span> — the pricing they bought — while{" "}
          <span className="font-mono">pro@v4</span> is an experiment for future customers.
        </p>
      </Specimen>
    ),
  },
  {
    title: "Metered usage features",
    body: "Flat, tiered, package, and usage features share one plan-version model. Usage features carry explicit meter configuration — no ad hoc counters.",
    specimen: (
      <Specimen caption="Meter config" fact="feature: ai_tokens">
        <LedgerRow label="feature" fact="ai_tokens · usage" variant="ghost" />
        <LedgerRow label="meter" fact="tokens_used · sum" variant="ghost" />
        <LedgerRow label="pricing rule" fact="$0.002 / token" variant="ghost" />
        <LedgerRow label="limit" fact="soft 500k · hard 1M" variant="ghost" />
        <LedgerRow label="reset" fact="each billing period" variant="ghost" />
      </Specimen>
    ),
  },
  {
    title: "Budgeted runs",
    body: "Put a budget envelope around multi-step work — an agent, a workflow, a job — with credits reserved up front. The run is denied mid-flight the moment the envelope is spent.",
    specimen: (
      <Specimen caption="Budgeted run" fact="runs.start / consume / end">
        <LedgerRow label="runs.start" fact="run_9f3k · reserve $12.00" variant="ghost" />
        <LedgerRow label="runs.consume" fact="step 14 · −$0.31" variant="ghost" />
        <LedgerRow label="remaining" fact="$8.12 of $12.00" variant="ghost" />
        <LedgerRow label="runs.end" fact="captured $9.63 · released $2.37" variant="ghost" />
        <LedgerRow
          label="over budget?"
          fact="rejected in-flight · 429"
          variant="ghost"
          factClassName="text-danger-text"
        />
      </Specimen>
    ),
  },
  {
    title: "Invoice evidence",
    body: "Every charge explains itself. An invoice line traces back to the plan version, pricing rule, rated usage, wallet movement, and ledger capture that produced it.",
    specimen: (
      <Specimen caption="Invoice line" fact="explainable">
        <LedgerRow label="ai tokens · 412,038 × $0.002" fact="$824.08" />
        <div className="mt-3 border-background-border border-t pt-2">
          <LedgerRow label="plan version" fact="pro@v3" variant="ghost" labelClassName="text-xs" />
          <LedgerRow
            label="rated events"
            fact="412,038 · replayable"
            variant="ghost"
            labelClassName="text-xs"
          />
          <LedgerRow
            label="wallet movement"
            fact="−$50.00 credit applied"
            variant="ghost"
            labelClassName="text-xs"
          />
          <LedgerRow
            label="ledger capture"
            fact="balanced · double-entry"
            variant="ghost"
            labelClassName="text-xs"
          />
        </div>
      </Specimen>
    ),
  },
]

export function CapabilitiesSection() {
  return (
    <SectionShell labelledBy="capabilities-title">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="The runtime" fact="one money path" />
        <h2
          id="capabilities-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          One money path, shown as state.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Plans, meters, budgets, wallets, and invoices are not separate products — they are
          stations on one money path, separate but connected. Each capability below is real product
          state, not a feature card.
        </p>
      </div>

      <div className="mt-8 flex flex-col">
        {capabilities.map((capability) => (
          <div
            key={capability.title}
            className="grid gap-6 border-background-border border-t py-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16"
          >
            <div>
              <h3 className="font-medium text-background-textContrast text-lg">
                {capability.title}
              </h3>
              <p className="mt-3 text-background-text text-sm leading-6">{capability.body}</p>
            </div>
            {capability.specimen}
          </div>
        ))}
      </div>

      <Link
        href={`${DOCS_DOMAIN}`}
        target="_blank"
        className="group inline-flex items-center gap-1.5 font-mono text-background-text text-xs transition-colors hover:text-background-textContrast"
      >
        SDK reference
        <ArrowRight
          aria-hidden
          className="size-3 transition-transform group-hover:translate-x-0.5"
        />
      </Link>
    </SectionShell>
  )
}
