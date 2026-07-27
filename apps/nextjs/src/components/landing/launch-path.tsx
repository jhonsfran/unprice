import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"
import { ProofLink } from "./proof-link"
import { Reveal } from "./reveal"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 04 merges what used to be two stations (a three-tab integration
// ladder and a separate adoption path). They were making one argument in two
// places: here is the code, and here is why running it costs you nothing.
//
// The snippet is the honest two calls and nothing else. It used to be
// thirty-eight lines directly under the sentence "the first integration is
// two calls" — the claim and its evidence disagreeing inside one viewport
// (launch audit 2026-07-27). Error handling, redirect URLs and the metering
// and budget rungs all still exist; they live in the SDK reference, one link
// away, where a reader who has already decided goes looking for them.
//
// Every line here is real SDK surface validated against the route schemas. If
// the API changes, this changes with it.

const GATE_SNIPPET = `import { Unprice } from "@unprice/api"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN })

// Once, at your own signup.
const { result: customer } = await unprice.customers.signUp({
  name: "Acme Inc.",
  email: "buyer@acme.com",
  planSlug: "pro",
})

// Before the paid action, every time.
const { result } = await unprice.access.check({
  customerId: customer.customerId,
  featureSlug: "tokens",
})

if (!result.allowed) return denied(result.rejectionReason)
`

// A real sequence, and the order is the argument: enforcement is last and it
// is opt-in. Each stage names what runs and — the part that actually reduces
// the risk — what it cannot touch.
const stages = [
  {
    title: "Shadow",
    body: "Run the decision beside the logic you already trust. Compare answers without changing behavior.",
    facts: [
      { label: "runs", fact: "access.check" },
      { label: "mutates", fact: "nothing · read-only" },
      { label: "blocks", fact: "nothing" },
    ],
  },
  {
    title: "Sandbox",
    body: "Prove the path before a dollar moves — model customers, plans, and budgets.",
    facts: [
      { label: "processor", fact: "none · built-in Sandbox" },
      { label: "customers", fact: "simulated" },
      { label: "evidence", fact: "real · inspectable" },
    ],
  },
  {
    title: "Your own Stripe",
    body: "Go live in your own account. Unprice owns the money path; your provider still captures the payment.",
    facts: [
      { label: "funds flow", fact: "yours · always" },
      { label: "capture", fact: "your Stripe account" },
      { label: "unprice", fact: "never in the middle" },
    ],
  },
]

export function LaunchPathSection() {
  return (
    <SectionShell labelledBy="launch-path-title">
      <div className="flex flex-col items-start">
        <StationHeader index="04" label="First integration" fact="two calls · nothing blocks" />
        <h2
          id="launch-path-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Two calls, and nothing in your stack changes.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            customers.signUp
          </code>{" "}
          once, at your own signup, then{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            access.check
          </code>{" "}
          in front of the paid action. The check is read-only, so on day one it decides nothing — it
          just tells you what it would have decided.
        </p>
      </div>

      <figure className="mt-12 max-w-3xl">
        <div className="rounded-lg border border-background-border bg-surface-panel shadow-ambient">
          <div className="flex items-center justify-between gap-4 border-background-border border-b px-4 py-2 sm:px-5">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              signUp → check
            </span>
            <CopyToClipboard code={GATE_SNIPPET} variant="ghost" className="size-7" />
          </div>
          <div className="overflow-x-auto px-4 py-4 sm:px-5">
            <CodeEditor codeBlock={GATE_SNIPPET} language="typescript" />
          </div>
        </div>
        <figcaption className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          <span className="max-w-xl">
            This is the integration the walk-away guarantee is written against. Metering what ran,
            and capping a whole job or agent, are one more call each.
          </span>
          <ProofLink
            source="integration_sdk"
            href="https://docs.unprice.dev"
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-sm font-medium text-background-textContrast",
              focusRing
            )}
          >
            Explore the request-path SDK
            <ArrowRight
              aria-hidden
              className="size-3 transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
            />
          </ProofLink>
        </figcaption>
      </figure>

      <div className="relative mt-16">
        <span
          aria-hidden
          className="absolute top-[4px] left-0 hidden h-px w-full bg-background-border sm:block"
        />
        <Reveal as="ol" stagger className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {stages.map((stage, index) => (
            <li key={stage.title} className="relative flex flex-col sm:pt-6">
              <span
                aria-hidden
                className="-translate-y-1/2 absolute top-[4px] left-0 hidden size-[9px] rounded-full border border-background-borderHover bg-background-base sm:block"
              />
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-background-text">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="font-medium text-background-textContrast text-lg">{stage.title}</h3>
              </div>
              <p className="mt-3 text-background-text text-sm leading-6">{stage.body}</p>
              <div className="mt-4 flex flex-col border-background-border border-t pt-2">
                {stage.facts.map((row) => (
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
        </Reveal>
      </div>
    </SectionShell>
  )
}
