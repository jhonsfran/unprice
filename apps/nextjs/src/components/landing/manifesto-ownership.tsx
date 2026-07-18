import { buttonVariants } from "@unprice/ui/button"
import { GitHub } from "@unprice/ui/icons"
import { Link } from "next-view-transitions"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The ownership argument, expanded from the landing's independence section
// into the manifesto's emotional core: the 2025-2026 consolidation of the
// billing middle market, rendered as a trace. Facts dated per
// docs/brand/positioning-and-messaging.md (July 2026 snapshot) — verify
// quarterly before republishing.

const consolidationTrace = [
  { time: "2025-02", event: "Zuora", fact: "taken private · Silver Lake" },
  { time: "2025-09", event: "OpenMeter", fact: "acquired · Kong" },
  { time: "2026-01", event: "Metronome", fact: "acquired · Stripe · ~$1B" },
  { time: "2026-06", event: "Orb", fact: "acquired · Adyen · $335M" },
]

const ownershipFacts = [
  { label: "license", fact: "AGPL-3.0 core · commercial available" },
  { label: "wallet ledger", fact: "double-entry · always balances" },
  { label: "schemas", fact: "plans · versions · meters · entitlements" },
  { label: "SDK", fact: "generated from OpenAPI contracts" },
  { label: "runtime", fact: "Cloudflare Workers + DOs · your account" },
  { label: "payments", fact: "Stripe-first · provider-extensible" },
  { label: "funds flow", fact: "yours — unprice never sits in it" },
]

export default function ManifestoOwnership() {
  return (
    <SectionShell labelledBy="ownership-title" surface="panel">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader index="03" label="Ownership" fact="forkable · runs in your account" />
          <h2
            id="ownership-title"
            className="mt-6 max-w-xl font-primary text-background-textContrast text-display-3"
          >
            The billing layer you rent can be acquired. The money path you own cannot.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Between 2025 and 2026 the independent billing middle market stopped existing: every
            metering-first vendor was acquired by a payment processor or left the market. Revenue
            logic trapped in a closed runtime is one acquisition away from belonging to someone
            else&apos;s roadmap.
          </p>
          <p className="mt-4 max-w-xl text-background-text text-sm leading-6">
            Unprice keeps the customer spend decision, the double-entry ledger, and the invoice
            explanation in one open money path you can read, fork, and run in your own Cloudflare
            account. Read the code that guards your money — or have your agent read it — before you
            trust it.
          </p>
          <div className="mt-8">
            <Link
              href="https://github.com/jhonsfran1165/unprice"
              target="_blank"
              className={buttonVariants({ variant: "outline", className: "gap-2" })}
            >
              <GitHub aria-hidden className="size-4" />
              Read the source
            </Link>
          </div>
        </div>

        <div className="flex h-fit flex-col gap-6">
          <figure
            aria-label="The billing middle market, traced: Zuora taken private by Silver Lake in February 2025, OpenMeter acquired by Kong in September 2025, Metronome acquired by Stripe for about one billion dollars in January 2026, Orb acquired by Adyen for 335 million dollars in June 2026. No independent metering-first vendor remains."
            className="rounded-lg border border-background-border bg-surface-raised p-4 sm:p-5"
          >
            <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
              <span className="font-mono text-background-text text-xs uppercase tracking-widest">
                The billing middle market
              </span>
              <span className="font-mono text-[10px] text-background-text">2025–2026 · traced</span>
            </figcaption>
            <div className="flex flex-col">
              {consolidationTrace.map((row) => (
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
            <div className="mt-4 border-background-border border-t pt-3">
              <LedgerRow label="independent metering-first vendors" fact="none remaining" />
              <LedgerRow
                label="your money path"
                fact="yours · AGPL-3.0"
                variant="ghost"
                factClassName="text-success-text"
              />
            </div>
          </figure>

          <div className="rounded-lg border border-background-border bg-surface-raised p-4 sm:p-5">
            <div className="mb-3 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
              <span className="font-mono text-background-text text-xs uppercase tracking-widest">
                What you own
              </span>
              <span className="hidden font-mono text-[10px] text-background-text sm:inline">
                inspect before you trust
              </span>
            </div>
            <div className="flex flex-col">
              {ownershipFacts.map((row) => (
                <LedgerRow key={row.label} label={row.label} fact={row.fact} variant="ghost" />
              ))}
            </div>
            <p className="mt-3 border-background-border border-t pt-3 font-mono text-[11px] text-background-text">
              git clone github.com/jhonsfran1165/unprice
            </p>
          </div>
        </div>
      </div>
    </SectionShell>
  )
}
