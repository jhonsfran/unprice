import Balancer from "react-wrap-balancer"
import { LedgerRow } from "./station"

// The manifesto opener: the change in the world, stated calmly. The essay era
// of this page (centered prose, golden-ratio decoration) is replaced by the
// same annotated-trace grammar as the landing — the argument as state.

const staticSigns = [
  { label: "over-budget usage", fact: "no way to stop it before it runs" },
  { label: "pricing change", fact: "edits product code · scripts · cron" },
  { label: "pricing logic", fact: "hardcoded in the product" },
  { label: "disputed invoice", fact: "reconstructed from logs · by hand" },
]

export default function ManifestoHero() {
  return (
    <section aria-labelledby="manifesto-title" className="ledger-dots w-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-20 pb-16 text-center sm:pt-28 sm:pb-20">
        <p className="font-mono text-background-text text-xs uppercase tracking-widest">
          The Unprice manifesto
        </p>
        <h1
          id="manifesto-title"
          className="mt-6 max-w-3xl font-primary text-background-textContrast text-display-1"
        >
          <Balancer>
            <span className="text-background-text">Every AI charge starts with</span> an
            authorization.
          </Balancer>
        </h1>
        <p className="mt-6 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            An agent can spend a customer&apos;s credits before any invoice exists. A usage counter
            records the cost but can&apos;t stop the work.
          </Balancer>
        </p>
        <p className="mt-4 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <Balancer>
            So check the budget before the run, and deny the work the customer can&apos;t pay for.
          </Balancer>
        </p>

        <figure
          aria-label="The signs of static, after-the-fact pricing: over-budget usage cannot be stopped before it runs, pricing changes edit product code and scripts and cron jobs at once, pricing logic is hardcoded in the product, and disputed invoices are reconstructed from logs by hand."
          className="mt-12 w-full max-w-xl rounded-lg border border-background-border bg-surface-panel p-4 text-left shadow-ambient sm:p-5"
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
            cause: the billing decision happens after the cost
          </p>
        </figure>
      </div>
    </section>
  )
}
