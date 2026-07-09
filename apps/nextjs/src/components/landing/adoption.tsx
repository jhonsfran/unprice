import { Reveal } from "./reveal"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The adoption path is the trust argument: a real sequence (so the rail and
// the step order carry information), where each stage names what runs and —
// more importantly — what it cannot touch. Enforcement is the last step and
// it is opt-in.

const stages = [
  {
    title: "Shadow",
    body: "Run the decision beside the logic you already trust. Compare answers in production without changing behavior.",
    facts: [
      { label: "runs", fact: "access.check" },
      { label: "mutates", fact: "nothing · read-only" },
      { label: "blocks", fact: "nothing" },
    ],
  },
  {
    title: "Sandbox",
    body: "Prove the path before a dollar moves. Model customers, plan versions, budgets, credits, invoices, and failures.",
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

const objections = [
  {
    question: "Why not just Stripe?",
    answer:
      "Keep Stripe for payment capture. Unprice owns the customer money path before and around the invoice: plan versions, entitlements, budgets, credits, ledger captures, and evidence.",
  },
  {
    question: "Why not an AI gateway?",
    answer:
      "Gateways cap provider spend. Unprice governs what your customer is allowed to spend and connects that decision to invoice evidence.",
  },
  {
    question: "Is it safe enough for money logic?",
    answer:
      "Do not adopt it all at once. Read the source, run one request path in shadow, prove it on Sandbox, then enforce only when the evidence matches.",
  },
  {
    question: "Do I need Cloudflare?",
    answer:
      "Today, yes. The runtime deploys to your own Cloudflare account — Workers, Durable Objects, Queues — because the spend decision needs fast per-customer state where requests run. Your account, your data, your keys.",
  },
]

export function AdoptionSection() {
  return (
    <SectionShell labelledBy="adoption-title">
      <div className="flex flex-col items-start">
        <StationHeader index="05" label="Adoption path" fact="shadow → sandbox → live" />
        <h2
          id="adoption-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Try it without touching your current logic.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Nothing blocks traffic until the evidence convinces you. When the shadow decision matches
          reality, switch{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            access.check
          </code>{" "}
          to{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            usage.consume
          </code>{" "}
          and enforcement is one line, not a migration.
        </p>
      </div>

      <div className="relative mt-14">
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

      <div className="mt-14 grid gap-x-8 border-background-border border-t md:grid-cols-2">
        {objections.map((item) => (
          <div key={item.question} className="border-background-border py-6 md:border-t-0">
            <h3 className="font-medium text-background-textContrast text-sm">{item.question}</h3>
            <p className="mt-2 text-background-text text-sm leading-6">{item.answer}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
