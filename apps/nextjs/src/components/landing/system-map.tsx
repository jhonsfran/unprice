import { cn } from "@unprice/ui/utils"
import { Leader, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Where Unprice sits, rendered as state: the app that triggers the paid
// action, the money path that decides and keeps the evidence, and the
// payment provider that captures the payment. Answers "where does this sit?"
// the way the money path answers "what happens?". The center panel carries
// the logo's bracket motif — pricing pulled into one inspectable place — and
// the provider panel renders pluggability as a ghost row (Stripe-first
// today, provider-extensible by design; never claim live providers).

type MapRow = { label: string; fact: string; ghost?: boolean }

const appRows: MapRow[] = [
  { label: "The paid action", fact: "about to run" },
  { label: "Asks before it runs", fact: "access.check" },
]

const pathRows: MapRow[] = [
  { label: "Plan versions", fact: "pinned per customer" },
  { label: "Entitlements", fact: "separate from plans" },
  { label: "Meters & usage", fact: "event-native" },
  { label: "Customer budgets", fact: "runs & workloads" },
  { label: "Wallet credits", fact: "double-entry ledger" },
  { label: "Invoice evidence", fact: "every line explained" },
]

const providerRows: MapRow[] = [
  { label: "Stripe", fact: "today · your account" },
  { label: "Next provider", fact: "extensible by design", ghost: true },
  { label: "Funds", fact: "stay with you" },
]

function MapRowLine({ row }: { row: MapRow }) {
  return (
    <div className="flex items-baseline gap-2 py-[5px]">
      <span
        className={cn(
          "text-sm",
          row.ghost ? "text-background-text" : "font-medium text-background-textContrast"
        )}
      >
        {row.label}
      </span>
      <Leader />
      <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
        {row.fact}
      </span>
    </div>
  )
}

function PanelHeader({ title, fact }: { title: string; fact: string }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3 border-background-border border-b pb-2.5">
      <span className="font-mono text-background-textContrast text-xs uppercase tracking-widest">
        {title}
      </span>
      <span className="font-mono text-[10px] text-background-text">{fact}</span>
    </div>
  )
}

// Between panels: what flows across the boundary, in both directions.
function FlowConnector({ top, bottom }: { top: string; bottom: string }) {
  return (
    <div aria-hidden>
      <div className="hidden flex-col items-center gap-1 self-center px-1.5 lg:flex">
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          {top}
        </span>
        <div className="relative h-px w-full border-background-borderHover border-t border-dashed">
          <span className="-left-0.5 -top-[3px] absolute size-[7px] rounded-full bg-background-borderHover" />
          <span className="-right-0.5 -top-[3px] absolute size-[7px] rounded-full bg-background-borderHover" />
        </div>
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          {bottom}
        </span>
      </div>
      <div className="flex items-center justify-center gap-2 py-1.5 lg:hidden">
        <span className="h-7 w-0 border-background-borderHover border-l border-dashed" />
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          {top} · {bottom}
        </span>
      </div>
    </div>
  )
}

export function SystemMap() {
  return (
    <SectionShell labelledBy="system-map-title">
      <div className="max-w-2xl">
        <StationHeader label="Where Unprice sits" fact="request → decision → invoice" />
        <h2
          id="system-map-title"
          className="mt-6 font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
        >
          The money path between your app and your payment provider.
        </h2>
        <p className="mt-5 text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Your app asks Unprice before paid work runs and gets an allow or deny with evidence
          attached. Your payment provider captures the payment — Stripe first today, and the
          provider model is designed so the money path never belongs to the processor.
        </p>
      </div>

      <figure
        aria-label="Where Unprice sits: your application triggers the paid action and asks Unprice before it runs. Unprice is the customer money path — spend authorization in the request path, plan versions pinned per customer, entitlements separate from plans, event-native meters, customer budgets for runs and workloads, wallet credits on a double-entry ledger, and invoice evidence that explains every line. Your payment provider captures the payment: Stripe today in your own account, extensible to your next provider by design. Funds stay with you."
        className="mt-10 sm:mt-12"
      >
        <div className="grid grid-cols-1 items-center gap-1 lg:grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,1.35fr)_5.5rem_minmax(0,1fr)] lg:gap-0">
          <div className="h-fit rounded-lg border border-background-border bg-background-bgSubtle p-4">
            <PanelHeader title="Your application" fact="the trigger" />
            {appRows.map((row) => (
              <MapRowLine key={row.label} row={row} />
            ))}
          </div>

          <FlowConnector top="request" bottom="decision" />

          <div className="relative rounded-lg border border-background-borderHover bg-background-bgSubtle p-4 sm:p-5">
            <span
              aria-hidden
              className="-top-px -left-px absolute size-3 border-primary-text border-t-2 border-l-2"
            />
            <span
              aria-hidden
              className="-top-px -right-px absolute size-3 border-primary-text border-t-2 border-r-2"
            />
            <span
              aria-hidden
              className="-bottom-px -left-px absolute size-3 border-primary-text border-b-2 border-l-2"
            />
            <span
              aria-hidden
              className="-bottom-px -right-px absolute size-3 border-primary-text border-r-2 border-b-2"
            />
            <PanelHeader title="Unprice" fact="customer money path" />
            <div className="mb-1.5 rounded-sm border border-primary-border bg-primary-bg px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-background-textContrast text-sm">
                  Spend authorization
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] text-primary-text">
                  in the request path
                </span>
              </div>
            </div>
            {pathRows.map((row) => (
              <MapRowLine key={row.label} row={row} />
            ))}
          </div>

          <FlowConnector top="invoice" bottom="capture" />

          <div className="h-fit rounded-lg border border-background-border bg-background-bgSubtle p-4">
            <PanelHeader title="Payment provider" fact="bring your own" />
            {providerRows.map((row) => (
              <MapRowLine key={row.label} row={row} />
            ))}
          </div>
        </div>

        <figcaption className="mt-5 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          Unprice owns the decision, the ledger, and the evidence. Your provider captures the
          payment — Unprice never sits in your funds flow.
        </figcaption>
      </figure>
    </SectionShell>
  )
}
