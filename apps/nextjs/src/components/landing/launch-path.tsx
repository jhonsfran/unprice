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
// (launch audit 2026-07-27).
//
// Two corrections from reading the page as a skeptical engineer (2026-07-27):
//
// 1. `access.check` is NOT shown as an enforcement gate any more. It is
//    read-only and reserves nothing, so `check` → run-the-work is a
//    time-of-check/time-of-use race: two concurrent requests both pass. That
//    is the same race this page criticises a Redis counter for, so shipping it
//    as the enforcement example was indefensible. The snippet now logs the
//    shadow decision, which is what a read-only call is actually for, and the
//    atomic primitives are named directly beneath it.
// 2. Budgeted runs are back on the page. They were a subordinate clause
//    ("capping a whole job or agent, are one more call each") — and they are
//    the primitive the sharpest slice of the ICP arrives searching for, because
//    an agent burning a budget overnight is one workload, not many requests.
//    A per-request check never saves that reader.
//
// Every line here is real SDK surface validated against the route schemas
// (startRunV1.ts, applyRunSyncEventV1.ts, budget-runs.ts). If the API changes,
// this changes with it.

const GATE_SNIPPET = `import { Unprice } from "@unprice/api"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN })

// Once, at your own signup.
const { result: customer } = await unprice.customers.signUp({
  name: "Acme Inc.",
  email: "buyer@acme.com",
  planSlug: "pro",
})

// Day one: read-only. Log what Unprice would have decided
// next to the answer your own logic gave.
const { result } = await unprice.access.check({
  customerId: customer.customerId,
  featureSlug: "tokens",
})

log({ unprice: result.allowed, mine: myExistingCheck() })
`

// The enforcing calls. Named here, in the open, because "which one goes in
// front of my LLM call?" is the question the shadow snippet deliberately does
// not answer — and guessing wrong is the race.
const enforcingCalls = [
  {
    call: "usage.consume",
    fact: "one request · ingests and denies atomically at the limit",
  },
  {
    call: "runs.start / consume / end",
    fact: "one workload · reserves a budget up front, stops itself when spent",
  },
]

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
    title: "Enforce, in your own Stripe",
    body: "Switch to a call that reserves, and go live in your own account. Unprice owns the decision; your provider still captures the payment.",
    facts: [
      { label: "enforces", fact: "usage.consume · runs.*" },
      { label: "funds flow", fact: "yours · always" },
      { label: "unprice", fact: "never in the middle" },
    ],
  },
]

export function LaunchPathSection() {
  return (
    <SectionShell labelledBy="launch-path-title">
      <div className="flex flex-col items-start">
        <StationHeader index="04" label="First integration" fact="shadow first · enforce later" />
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
          beside the logic you already trust. The check is read-only — it decides nothing, it just
          tells you what it would have decided.
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
        {/* The enforcement answer, stated rather than left to inference. A
            read-only check reserves nothing, so gating on it and then running
            the work lets two concurrent requests through — the reader has to
            be told which call is atomic, or they will ship the race. */}
        <div className="mt-6 border-background-border border-t pt-4">
          <p className="text-background-text text-sm leading-6">
            When the shadow decision matches reality, enforce with a call that reserves. Never gate
            on{" "}
            <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[12px] text-background-textContrast">
              access.check
            </code>{" "}
            alone — it reserves nothing, so two concurrent requests both pass it.
          </p>
          <div className="mt-3 flex flex-col">
            {enforcingCalls.map((row) => (
              <LedgerRow
                key={row.call}
                label={row.call}
                labelClassName="font-mono text-xs"
                fact={row.fact}
              />
            ))}
          </div>
        </div>

        <figcaption className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          <span className="max-w-xl">
            The two calls above are the integration the walk-away guarantee is written against —
            read-only, blocking nothing.
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
