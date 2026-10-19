import { BUDGETS_TWO_CALLS } from "./budgets-snippets"
import { CodePanel } from "./code-panel"
import { Reveal } from "./reveal"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 03 — the two calls, as the README writes them: set the cap once,
// then wrap the call the agent already makes. Under the editor the billing
// stack renders as ghosts, because "nothing to migrate" is a claim about what
// does not change, and absence is the page's proof grammar.

const untouched = ["plans", "subscriptions", "invoices", "payment provider"]

export function BudgetsIntegration() {
  return (
    <SectionShell labelledBy="budgets-integration-title">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="Two calls" fact="nothing to migrate" />
        <h2
          id="budgets-integration-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Set a cap. Wrap the call.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            spend
          </code>{" "}
          holds the estimate, runs your function, and counts only what it actually cost. If the cap
          can&apos;t cover the estimate, your function never runs.
        </p>
      </div>

      <figure className="mt-12 max-w-3xl">
        <CodePanel filename="agent.ts" code={BUDGETS_TWO_CALLS} className="shadow-ambient" />

        <div className="mt-6 border-background-border border-t pt-4">
          <p className="text-background-text text-sm leading-6">
            Nothing in your billing stack changes.
          </p>
          <Reveal stagger className="mt-3 flex flex-col">
            {untouched.map((system) => (
              <LedgerRow key={system} label={system} variant="ghost" fact="untouched" />
            ))}
          </Reveal>
        </div>
      </figure>
    </SectionShell>
  )
}
