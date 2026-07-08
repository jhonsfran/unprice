import { buttonVariants } from "@unprice/ui/button"
import { ArrowRight } from "lucide-react"
import { Link } from "next-view-transitions"
import { Leader, LedgerRow, StationDot } from "~/components/landing/station"

// Utility pages are brand surfaces (design-system-guidelines.md): the 404 is
// a denial receipt — the money-path grammar applied to a missing route. As on
// any denied request, the proof is the absence of state.

const ghostStations = [
  { label: "Wallet", fact: "untouched" },
  { label: "Ledger", fact: "no entry" },
  { label: "Invoice", fact: "no line" },
]

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl items-center px-6">
      <div className="grid w-full items-center gap-10 py-16 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
        <div className="flex flex-col items-start">
          <p className="font-mono text-[10px] text-background-text uppercase tracking-widest">
            404 · not found
          </p>
          <h1 className="mt-4 font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl">
            This page was not authorized.
          </h1>
          <p className="mt-4 max-w-md text-background-text text-base leading-7">
            The route does not exist. As with any denied request, nothing ran and nothing was
            created: no wallet movement, no ledger entry, no invoice line.
          </p>
          <Link
            href="/"
            className={buttonVariants({ variant: "primary", className: "mt-8 gap-1.5" })}
          >
            Back to the money path
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>

        <figure
          aria-label="A denial receipt for this request: the route was not found, the request was denied before any work ran, the wallet is untouched, the ledger has no entry, the invoice has no line, and the cost created is zero dollars."
          className="h-fit max-w-md rounded-lg border border-background-border bg-background-bgSubtle p-4 sm:p-5 lg:w-full lg:justify-self-end"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              Denial receipt
            </span>
            <span className="font-mono text-[10px] text-background-text">one request · traced</span>
          </figcaption>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-2 py-[5px]">
              <StationDot variant="live" className="self-center" />
              <span className="font-medium text-background-textContrast text-sm">Request</span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
                GET · this page
              </span>
            </div>
            <div className="flex items-baseline gap-2 py-[5px]">
              <StationDot className="self-center" />
              <span className="font-medium text-background-textContrast text-sm">Route check</span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-danger-text">
                deny · not found
              </span>
            </div>
          </div>

          <div aria-hidden className="relative py-1.5">
            <span className="-translate-y-1/2 absolute top-1/2 left-0 h-px w-3 bg-background-border" />
            <span className="pl-6 font-mono text-[10px] text-background-text uppercase tracking-widest">
              denied before any work ran
            </span>
          </div>

          <div className="flex flex-col">
            {ghostStations.map((row) => (
              <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
                <StationDot variant="ghost" className="self-center" />
                <span className="text-background-text text-sm">{row.label}</span>
                <Leader />
                <span className="whitespace-nowrap font-mono text-[11px] text-background-text">
                  {row.fact}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 border-background-border border-t pt-3">
            <LedgerRow label="cost created" fact="$0.00" />
          </div>
        </figure>
      </div>
    </main>
  )
}
