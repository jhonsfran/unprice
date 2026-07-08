import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The offer, stated as ledger facts. A pricing company that hides its own
// deal undermines its authority, so the deal is rendered in the same receipt
// grammar as the product: every fact here is true today — no card at signup,
// no workspace billing in early access, AGPL-3.0 core.

const offers = [
  {
    title: "Run it yourself",
    body: "The full money path — plans, versions, entitlements, wallets, ledger, invoices — deployed to your own Cloudflare account. Read every line before you trust it.",
    facts: [
      { label: "license", fact: "AGPL-3.0 · free" },
      { label: "runs on", fact: "your Cloudflare account" },
      { label: "lock-in", fact: "none · fork it" },
    ],
  },
  {
    title: "Cloud",
    body: "The same runtime, hosted. Start on Sandbox, prove the path, then go live against your own Stripe account.",
    facts: [
      { label: "early access", fact: "free · today" },
      { label: "card at signup", fact: "none" },
      { label: "funds flow", fact: "your Stripe · always" },
    ],
  },
  {
    title: "Commercial license",
    body: "For teams that cannot open-source their modifications, or want dedicated support on the same core.",
    facts: [
      { label: "core", fact: "identical · no gated features" },
      { label: "support", fact: "dedicated" },
      { label: "start", fact: "seb@unprice.dev" },
    ],
  },
]

export function OfferSection() {
  return (
    <SectionShell labelledBy="offer-title">
      <div className="flex flex-col items-start">
        <StationHeader label="The offer" fact="free to prove · yours to keep" />
        <h2
          id="offer-title"
          className="mt-6 max-w-2xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
        >
          The pricing is as explainable as yours will be.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          The core is AGPL-3.0 and free to run in your own Cloudflare account. The hosted cloud is
          free during early access, with no card at signup. Payments settle to your own Stripe
          account either way — Unprice never sits in your funds flow.
        </p>
        <p className="mt-4 max-w-2xl text-background-text text-sm leading-6">
          The money path is yours to read, fork, and run in your own account — it cannot be acquired
          out from under you. The full argument is in{" "}
          <Link
            href="/manifesto"
            className="font-medium text-background-textContrast underline decoration-background-borderHover underline-offset-4 hover:decoration-background-textContrast"
          >
            the manifesto
          </Link>
          .
        </p>
      </div>

      <div className="relative mt-14">
        <span
          aria-hidden
          className="absolute top-[4px] left-0 hidden h-px w-full bg-background-border sm:block"
        />
        <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {offers.map((offer, index) => (
            <li key={offer.title} className="relative flex flex-col sm:pt-6">
              <span
                aria-hidden
                className="-translate-y-1/2 absolute top-[4px] left-0 hidden size-[9px] rounded-full border border-background-borderHover bg-background-base sm:block"
              />
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-background-text">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="font-medium text-background-textContrast text-lg">{offer.title}</h3>
              </div>
              <p className="mt-3 text-background-text text-sm leading-6">{offer.body}</p>
              <div className="mt-4 flex flex-col border-background-border border-t pt-2">
                {offer.facts.map((row) => (
                  <LedgerRow
                    key={row.label}
                    label={row.label}
                    variant="ghost"
                    fact={row.fact}
                    labelClassName="text-xs"
                  />
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-14 rounded-lg border border-background-border bg-background-bgSubtle p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            The walk-away guarantee
          </span>
          <span className="hidden font-mono text-[10px] text-background-text sm:inline">
            shadow · read-only · one line
          </span>
        </div>
        <p className="mt-3 max-w-3xl text-background-text text-sm leading-6">
          Adopt in shadow: one read-only <code className="font-mono text-[12px]">access.check</code>{" "}
          beside the logic you already trust, blocking nothing. If the decisions never match your
          reality, delete that one line and walk away — nothing migrated, nothing to unwind, no
          contract to exit. Enforce only when the evidence convinces you.
        </p>
      </div>

      <div className="mt-8">
        <Link
          href={`${APP_DOMAIN}`}
          className={buttonVariants({ variant: "outline", className: "gap-1.5" })}
        >
          Start free on Sandbox
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </SectionShell>
  )
}
