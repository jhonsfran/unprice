import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"
import { Reveal } from "./reveal"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 03 — the two calls, as the README writes them: set the cap once,
// then wrap the call the agent already makes. Under the editor the billing
// stack renders as ghosts, because "nothing to migrate" is a claim about what
// does not change, and absence is the page's proof grammar.

const TWO_CALLS = `import { Unprice } from "@unprice/budgets"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })

// 1. Set the cap once.
await unprice.budgets.upsert({
  key: "customer:acme",
  unit: "USD",
  limits: [{ amount: "50", window: "month" }],
})

// 2. Wrap the call your agent already makes.
const text = await unprice.budget("customer:acme").spend({ estimate }, async () => {
  const r = await generateText({ model, prompt, maxOutputTokens })
  return { value: r.text, actual: costOf(r.usage) }
})
`

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
          reserves the most the call can cost, runs it, and settles what it actually cost. When the
          cap cannot cover it, the call never runs.
        </p>
      </div>

      <figure className="mt-12 max-w-3xl">
        <div className="rounded-lg border border-background-border bg-surface-panel shadow-ambient">
          <div className="flex items-center justify-between gap-4 border-background-border border-b px-4 py-2 sm:px-5">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              agent.ts
            </span>
            <CopyToClipboard code={TWO_CALLS} variant="ghost" className="size-7" />
          </div>
          <div className="overflow-x-auto px-4 py-4 sm:px-5">
            <CodeEditor codeBlock={TWO_CALLS} language="typescript" />
          </div>
        </div>

        <div className="mt-6 border-background-border border-t pt-4">
          <p className="text-background-text text-sm leading-6">
            Your billing stack stays exactly where it is.
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
