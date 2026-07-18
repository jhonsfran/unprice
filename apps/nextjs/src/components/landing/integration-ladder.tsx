"use client"

import { API_DOMAIN } from "@unprice/config"
import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { useRef, useState } from "react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"

// The integration ladder: the first integration stays two calls (the claim
// the guarantee is written against), and the escalation is visible instead
// of buried in a caption — one more call meters the work, one more puts a
// budget around a whole workload. Three steps, one panel, honest counting
// on every rung. Every snippet is real SDK surface validated against the
// route schemas; if the API changes, these must change with it.

const API_BASE_URL = API_DOMAIN.replace(/\/$/, "")

const GATE_SNIPPET = `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
})

// Once, at your own signup: subscribe the customer to a
// plan. Unprice provisions the subscription and its
// entitlements, then returns the id you store.
const { result: signup } = await unprice.customers.signUp({
  name: "Acme Inc.",
  email: "buyer@acme.com",
  planSlug: "pro",
  externalId: "user_123", // your id for this customer
  successUrl: "https://your-app.com/welcome",
  cancelUrl: "https://your-app.com/pricing",
})

// Every request after that: check before the paid
// action runs.
const { result, error } = await unprice.access.check({
  customerId: signup.customerId,
  featureSlug: "tokens",
})

if (error) {
  console.error(error.message)
  return
}

if (!result.allowed) {
  // Denied in the request path — no cost was ever created.
  throw new Error("Denied before paid usage ran")
}

// Allowed: run the paid action. The same decision
// explains the invoice line later.
`

const METER_SNIPPET = `// Keep the check. After the paid work runs, record what
// it used — this call is queued, so it never blocks the
// request path.
await unprice.usage.record({
  customerId: signup.customerId,
  eventSlug: "tokens_used",
  idempotencyKey: "req_8f3a", // your request id — retries dedupe
  properties: { amount: 1240 }, // what the meter aggregates
})

// 202 accepted. The event lands in the entitlement
// window, and the same accepted usage becomes the
// invoice line — one evidence trail from check to charge.
`

const BUDGET_SNIPPET = `// Cap a whole workload — an agent, a job, a workflow —
// before it starts: reserve budget from the customer's
// wallet, in currency minor units.
const { result: run } = await unprice.runs.start({
  customerId: signup.customerId,
  budgetAmountMinor: 5000, // $50.00 for this run
  idempotencyKey: "run_7c21",
  workloadType: "agent",
  workloadId: "research-agent",
})

// Every step burns down the reservation and is denied
// the moment the budget is spent — not on the invoice.
const { result: step } = await unprice.runs.consume({
  runId: run.runId,
  featureSlug: "tokens",
  idempotencyKey: "evt_9d4e",
  properties: { amount: 1240 },
})

if (!step.accepted) {
  // Budget exhausted: the run stops before more cost exists.
}

await unprice.runs.end({ runId: run.runId, status: "completed" })
`

const STEPS = [
  {
    id: "gate",
    tab: "01 gate",
    chain: "signUp → check",
    caption:
      "Both calls shown, nothing hidden; the plan version comes from the dashboard. This is the integration the walk-away guarantee is written against.",
    code: GATE_SNIPPET,
  },
  {
    id: "meter",
    tab: "02 meter",
    chain: "check → record",
    caption:
      "Three calls total to a billable meter. When the gate and the meter should be one motion, usage.consume ingests and enforces in a single synchronous call.",
    code: METER_SNIPPET,
  },
  {
    id: "budget",
    tab: "03 budget",
    chain: "start → consume → end",
    caption:
      "Budgets ride the same money path: the reservation comes from the customer's wallet, and every consume writes the evidence the invoice explains later.",
    code: BUDGET_SNIPPET,
  },
] as const

type StepId = (typeof STEPS)[number]["id"]

export function IntegrationLadder() {
  const [active, setActive] = useState<StepId>("gate")
  const tabRefs = useRef<Map<StepId, HTMLButtonElement>>(new Map())
  const step = STEPS.find((s) => s.id === active) ?? STEPS[0]

  // Roving tabindex: arrows move focus and selection together, so the
  // ladder reads left-to-right on the keyboard the same way it escalates.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    event.preventDefault()
    const index = STEPS.findIndex((s) => s.id === active)
    const next =
      event.key === "ArrowRight"
        ? STEPS[(index + 1) % STEPS.length]
        : STEPS[(index - 1 + STEPS.length) % STEPS.length]
    if (!next) return
    setActive(next.id)
    tabRefs.current.get(next.id)?.focus()
  }

  return (
    <figure
      aria-label="The integration ladder: step one signs up a customer to a plan and checks access before the paid action runs; step two records usage after the work so the invoice explains itself; step three reserves a budget for a whole run and consumes it step by step until the budget is spent."
      className="mt-12 max-w-3xl"
    >
      {/* The section sits on the panel band, so the ladder lifts one tier
          higher — a panel on a panel disappears. */}
      <div className="rounded-lg border border-background-border bg-surface-raised shadow-ambient">
        <div className="flex items-center justify-between gap-4 border-background-border border-b px-4 py-2 sm:px-5">
          <div
            role="tablist"
            aria-label="Integration steps"
            onKeyDown={onKeyDown}
            className="flex items-center gap-4 sm:gap-5"
          >
            {STEPS.map((s) => (
              <button
                key={s.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(s.id, el)
                }}
                type="button"
                role="tab"
                id={`ladder-tab-${s.id}`}
                aria-selected={s.id === active}
                aria-controls={`ladder-panel-${s.id}`}
                tabIndex={s.id === active ? 0 : -1}
                onClick={() => setActive(s.id)}
                className={cn(
                  "rounded-sm font-mono text-xs uppercase tracking-widest transition-colors duration-quick ease-out-quad",
                  focusRing,
                  s.id === active
                    ? "text-background-textContrast"
                    : "text-background-text hover:text-background-textContrast"
                )}
              >
                {s.tab}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10px] text-background-text sm:inline">
              {step.chain}
            </span>
            <CopyToClipboard code={step.code} variant="ghost" className="size-7" />
          </div>
        </div>
        <div
          role="tabpanel"
          id={`ladder-panel-${step.id}`}
          aria-labelledby={`ladder-tab-${step.id}`}
          className="overflow-x-auto px-4 py-4 sm:px-5"
        >
          <CodeEditor codeBlock={step.code} language="typescript" />
        </div>
      </div>
      <figcaption className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-background-border border-t pt-3 text-background-text text-xs leading-6">
        <span className="max-w-xl">{step.caption}</span>
        <a
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
        </a>
      </figcaption>
    </figure>
  )
}
