import { MoneyPath } from "./money-path"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 04 opens the proof floor: the same paid action station 01's DIY
// trace lost, traced through Unprice end to end — the first receipt after
// the divider promises receipts. The hero shows this diagram abridged to the
// decision moment and its footer anchors here (#money-path); this render
// carries the terminal moments the hero defers: wallet, ledger, the invoice
// line that explains itself, and payment settling in the buyer's own Stripe.

export function MoneyPathSection() {
  return (
    <SectionShell id="money-path" labelledBy="money-path-title">
      <div className="flex flex-col items-start">
        <StationHeader
          index="04"
          label="The money path"
          fact="allow settles · deny costs nothing"
        />
        <h2
          id="money-path-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          The decision becomes the invoice.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          An allow reserves the wallet, captures the ledger, and writes an invoice line that
          explains itself — settled in your own Stripe. A deny leaves nothing behind: no entry, no
          line, no charge, and the reason returned to your app.
        </p>
      </div>

      <div className="mt-12 w-full max-w-3xl rounded-lg border border-background-border bg-surface-panel p-4 shadow-raised sm:p-6">
        <MoneyPath />
      </div>
    </SectionShell>
  )
}
