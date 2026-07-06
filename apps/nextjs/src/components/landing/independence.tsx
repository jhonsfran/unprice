import { buttonVariants } from "@unprice/ui/button"
import { GitHub } from "@unprice/ui/icons"
import { Link } from "next-view-transitions"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The ownership argument. The billing middle market consolidated into
// payment processors; the layer that guards margin should not be a vendor's
// asset. Stated as facts about the code, not as fear copy.

const ownershipFacts = [
  { label: "license", fact: "AGPL-3.0 core · commercial available" },
  { label: "wallet ledger", fact: "double-entry · always balances" },
  { label: "schemas", fact: "plans · versions · meters · entitlements" },
  { label: "SDK", fact: "generated from OpenAPI contracts" },
  { label: "payments", fact: "Stripe-first · provider-extensible" },
  { label: "funds flow", fact: "yours — unprice never sits in it" },
]

export function IndependenceSection() {
  return (
    <SectionShell labelledBy="independence-title" className="bg-background-bgSubtle">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader label="Ownership" fact="forkable · self-hostable" />
          <h2
            id="independence-title"
            className="mt-6 max-w-xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
          >
            Your rent can be acquired. The money path you own cannot.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Revenue logic trapped in a closed runtime is one acquisition away from belonging to a
            payment processor. Unprice keeps the customer spend decision, the double-entry ledger,
            and the invoice explanation in one open money path you can read, self-host, and fork.
          </p>
          <p className="mt-4 max-w-xl text-background-text text-sm leading-6">
            Read the code that guards your money — or have your agent read it — before you trust it.
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

        <div className="h-fit rounded-lg border border-background-border bg-background-base p-4 sm:p-5">
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
    </SectionShell>
  )
}
