import Balancer from "react-wrap-balancer"
import { LedgerRow } from "./station"

// The manifesto opener: the change in the world, stated calmly. The essay era
// of this page (centered prose, golden-ratio decoration) is replaced by the
// same annotated-trace grammar as the landing — the argument as state.

const staticSigns = [
  { label: "over-budget usage", fact: "no way to stop it before it runs" },
  { label: "packaging change", fact: "edits product code · scripts · cron" },
  { label: "pricing logic", fact: "hardcoded · config, not decision" },
  { label: "disputed invoice", fact: "reconstructed from logs · by hand" },
]

export default function ManifestoHero() {
  return (
    <section aria-labelledby="manifesto-title" className="w-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-20 pb-16 text-center sm:pt-28 sm:pb-20">
        <p className="font-mono text-background-text text-xs uppercase tracking-widest">
          The Unprice manifesto
        </p>
        <h1
          id="manifesto-title"
          className="mt-6 max-w-3xl font-primary font-semibold text-4xl text-background-textContrast leading-[1.08] tracking-tight sm:text-5xl sm:leading-[1.06]"
        >
          <Balancer>Pricing is a runtime decision.</Balancer>
        </h1>
        <p className="mt-6 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            SaaS pricing was built for a static era: hardcoded tiers, manual feature gates,
            end-of-cycle invoices. For usage-based products that model breaks the moment usage gets
            expensive — a single customer, job, workflow, or agent can cross its budget before
            anyone reaches the invoice.
          </Balancer>
        </p>
        <p className="mt-4 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            So the pricing decision has to move to where the cost is created: the request path.
            Check entitlement, check budget, reserve credits, deny over-budget work before it runs —
            then explain every charge from the same evidence.
          </Balancer>
        </p>

        <figure
          aria-label="The signs of static, after-the-fact pricing: over-budget usage cannot be stopped before it runs, packaging changes edit product code and scripts and cron jobs at once, pricing logic is hardcoded configuration instead of a decision, and disputed invoices are reconstructed from logs by hand."
          className="mt-12 w-full max-w-xl rounded-lg border border-background-border bg-background-bgSubtle p-4 text-left sm:p-5"
        >
          <figcaption className="mb-3 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              Static pricing · diagnosed
            </span>
            <span className="hidden font-mono text-[10px] text-background-text sm:inline">
              four symptoms · one cause
            </span>
          </figcaption>
          <div className="flex flex-col">
            {staticSigns.map((row) => (
              <LedgerRow key={row.label} label={row.label} fact={row.fact} variant="ghost" />
            ))}
          </div>
          <p className="mt-3 border-background-border border-t pt-3 font-mono text-[11px] text-background-text">
            cause: the money decision runs after the cost exists
          </p>
        </figure>
      </div>
    </section>
  )
}
