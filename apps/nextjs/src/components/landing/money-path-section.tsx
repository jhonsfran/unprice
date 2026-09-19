import { MoneyPath } from "./money-path"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 02 answers station 01 directly: the same paid action the DIY trace
// lost, traced through Unprice end to end. It sits immediately after the
// incident because the signature proof should not wait behind two supporting
// arguments (launch audit 2026-07-27). The hero shows only the read-only gate
// and anchors here; this render is the enforcing call and carries what the
// hero defers — wallet, ledger, the invoice line that explains itself, and
// payment settling in the buyer's own Stripe.

export function MoneyPathSection() {
  return (
    <SectionShell id="money-path" labelledBy="money-path-title">
      <div className="flex flex-col items-start">
        <StationHeader
          index="02"
          label="The money path"
          fact="allow settles · deny costs nothing"
        />
        <h2
          id="money-path-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          The authorization becomes the receipt.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          An allow reserves against the customer&apos;s budget before the agent runs. After the work
          completes, Unprice settles actual usage, captures the ledger movement, and writes the
          invoice line. A deny makes zero provider calls: no work, no ledger entry, no invoice line,
          no charge.
        </p>
      </div>

      <div className="mt-12 w-full max-w-3xl rounded-lg border border-background-border bg-surface-panel p-4 shadow-raised sm:p-6">
        <MoneyPath />
      </div>
    </SectionShell>
  )
}
