import { DOCS_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import Balancer from "react-wrap-balancer"
import { AcquisitionLink } from "./acquisition-link"
import CopyToClipboard from "./copy-to-clipboard"
import { ProofLink } from "./proof-link"
import { Reveal } from "./reveal"
import { Leader, LedgerRow, StationDot } from "./station"

// The Budgets page opens on the launch video's own words, so a reader who
// arrives from it lands on the promise they just heard (message match,
// marketing-framework.md). The receipt beside the headline is not a drawing:
// it is the BudgetDO concurrency test, rendered as its hundred agents. Solid
// cells ran, ghost cells never did (the page-wide grammar), and the one amber
// fact is the decision: nothing went over the cap.

export const BUDGETS_INSTALL = "npm i @unprice/budgets"

const REPO_URL = "https://github.com/jhonsfran1165/unprice"
const RACE_TEST_URL = `${REPO_URL}/blob/main/apps/api/src/ingestion/budget/BudgetDO.workers.test.ts`

// From "never lets 100 parallel authorizes exceed a $50 cap": 100 × $0.75
// against $50.00, of which 66 fit ($49.50 held) and 34 are refused.
const AGENTS = 100
const ALLOWED = 66

export function InstallCommand({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-background-border bg-surface-panel py-1 pr-1 pl-3",
        className
      )}
    >
      <span aria-hidden className="select-none font-mono text-background-text text-xs">
        $
      </span>
      <code className="font-mono text-background-textContrast text-xs">{BUDGETS_INSTALL}</code>
      <CopyToClipboard code={BUDGETS_INSTALL} variant="ghost" className="size-7" />
    </div>
  )
}

export function BudgetsHero() {
  return (
    <section
      aria-labelledby="budgets-hero-title"
      className="ledger-dots mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-6xl flex-col justify-center px-6 py-12"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-14">
        <div className="flex flex-col items-start">
          <p className="font-mono text-background-text text-sm uppercase tracking-widest">
            Unprice Budgets
          </p>
          <h1
            id="budgets-hero-title"
            className="mt-5 font-primary text-background-textContrast text-display-1"
          >
            <Balancer>
              <span className="text-background-text">Hard caps.</span> Per key. Actually hard.
            </Balancer>
          </h1>
          <p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Put a budget in front of your agent. Every paid call checks it first, and a call the cap
            cannot cover never reaches the provider. Your billing stays where it is.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <AcquisitionLink
              source="budgets_hero"
              className={buttonVariants({ variant: "primary", className: "gap-1.5" })}
            >
              Get an API key
            </AcquisitionLink>
            <a
              href={`${DOCS_DOMAIN}budgets/quickstart`}
              className={buttonVariants({ variant: "outline" })}
            >
              Read the quickstart
            </a>
          </div>
          <InstallCommand className="mt-6" />
        </div>

        <figure
          aria-label="From the test suite: 100 agents authorize $0.75 each in parallel against one $50 cap. 66 are allowed and hold $49.50. 34 are refused with BUDGET_EXCEEDED. Nothing goes over the cap."
          className="rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient sm:p-5"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              100 agents · one cap
            </span>
            <span className="hidden whitespace-nowrap font-mono text-[10px] text-background-text sm:inline">
              budget · customer:acme
            </span>
          </figcaption>

          <div aria-hidden className="grid grid-cols-[repeat(20,minmax(0,1fr))] gap-1 sm:gap-1.5">
            {Array.from({ length: AGENTS }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid of identical cells
                key={i}
                className={cn(
                  "aspect-square rounded-[2px]",
                  i < ALLOWED
                    ? "bg-background-text"
                    : "border border-background-borderHover border-dashed"
                )}
              />
            ))}
          </div>

          <Reveal stagger className="mt-5 flex flex-col border-background-border border-t pt-3">
            <LedgerRow label="authorize · $0.75 each" variant="ghost" fact="100 in parallel" />
            <div className="flex items-baseline gap-2 py-[5px]">
              <StationDot variant="terminal" className="self-center" />
              <span className="font-medium text-background-textContrast text-sm">allowed</span>
              <Leader />
              <span className="font-mono text-[11px] text-background-text">66 · $49.50 held</span>
            </div>
            <div className="flex items-baseline gap-2 py-[5px]">
              <StationDot variant="ghost" className="self-center" />
              <span className="text-background-text text-sm">
                refused<span className="hidden sm:inline"> · never ran</span>
              </span>
              <Leader />
              <span className="font-medium font-mono text-[11px] text-danger-text">
                34 · 402 BUDGET_EXCEEDED
              </span>
            </div>
            <div className="mt-2 border-background-border border-t pt-2">
              <LedgerRow
                label="over the $50.00 cap"
                fact="$0.00"
                factClassName="font-medium text-primary-text text-xs"
              />
            </div>
          </Reveal>

          <ProofLink
            source="budgets_test"
            href={RACE_TEST_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group mt-4 inline-flex items-baseline gap-1.5 rounded-sm font-mono text-[11px] text-background-text hover:text-background-textContrast",
              focusRing
            )}
          >
            BudgetDO.workers.test.ts · read the test
            <ArrowRight
              aria-hidden
              className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
            />
          </ProofLink>
        </figure>
      </div>
    </section>
  )
}
