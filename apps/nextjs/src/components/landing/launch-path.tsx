import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"
import { ProofLink } from "./proof-link"
import { Reveal } from "./reveal"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// This is the runtime value in one frame. The reservation happens before the
// provider call. Settlement records actual usage and releases the unused hold.
const RESERVATION_SNIPPET = `import { generateText } from "ai"
import { Unprice } from "@unprice/api"

const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN })

// 1. Reserve the most this model call may cost.
const { result: reservation, error } = await unprice.reservations.reserve({
  customerId,
  maximumAmountMinor: 10, // $0.10 from customer credits
  idempotencyKey: messageId,
})

// Stop here. The provider never runs without customer funding.
if (error) {
  return new Response("Customer budget unavailable", { status: 402 })
}

// 2. Spend only after the reservation succeeds.
const generation = await generateText({
  model,
  prompt,
  maxOutputTokens: 2_000,
})

// 3. Capture actual usage and release the unused amount.
const settlement = await reservation.settle({
  featureSlug: "ai-tokens",
  eventSlug: "ai-completion",
  id: messageId,
  properties: {
    input_tokens: generation.usage.inputTokens,
    output_tokens: generation.usage.outputTokens,
  },
})

if (settlement.error) throw settlement.error

return Response.json({ text: generation.text })
`

const supportingCalls = [
  {
    call: "usage.consume",
    fact: "known cost · authorize and consume in one atomic call",
  },
  {
    call: "access.check",
    fact: "shadow only · read-only and reserves nothing",
  },
]

const stages = [
  {
    title: "Reserve",
    body: "Hold the maximum cost against the customer's credits before calling the model provider.",
    facts: [
      { label: "customer", fact: "funds the work" },
      { label: "held", fact: "$0.10 maximum" },
      { label: "denied", fact: "no provider call" },
    ],
  },
  {
    title: "Run",
    body: "Start the agent only after Unprice confirms the reservation.",
    facts: [
      { label: "provider", fact: "your model account" },
      { label: "limit", fact: "2,000 output tokens" },
      { label: "executor", fact: "your application" },
    ],
  },
  {
    title: "Settle",
    body: "Report actual token usage. Unprice captures the funded amount and closes the reservation.",
    facts: [
      { label: "captured", fact: "actual usage" },
      { label: "released", fact: "unused hold" },
      { label: "evidence", fact: "usage → invoice" },
    ],
  },
]

export function LaunchPathSection() {
  return (
    <SectionShell labelledBy="launch-path-title">
      <div className="flex flex-col items-start">
        <StationHeader index="04" label="First integration" fact="reserve · run · settle" />
        <h2
          id="launch-path-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Reserve the customer&apos;s money before the model spends yours.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Reserve a maximum from the customer&apos;s credits before{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            generateText
          </code>{" "}
          runs. If the reservation fails, do not call the provider. After the run, settle actual
          token usage and release the rest.
        </p>
      </div>

      <figure className="mt-12 max-w-3xl">
        <div className="rounded-lg border border-background-border bg-surface-panel shadow-ambient">
          <div className="flex items-center justify-between gap-4 border-background-border border-b px-4 py-2 sm:px-5">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              reserve → generate → settle
            </span>
            <CopyToClipboard code={RESERVATION_SNIPPET} variant="ghost" className="size-7" />
          </div>
          <div className="overflow-x-auto px-4 py-4 sm:px-5">
            <CodeEditor codeBlock={RESERVATION_SNIPPET} language="typescript" />
          </div>
        </div>
        <div className="mt-6 border-background-border border-t pt-4">
          <p className="text-background-text text-sm leading-6">
            Use the smallest operation that matches the work. A reservation fits variable-cost AI
            calls. These two paths cover simpler cases.
          </p>
          <div className="mt-3 flex flex-col">
            {supportingCalls.map((row) => (
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
            This is the same reservation pattern used by the working open-source AI chatbot.
          </span>
          <ProofLink
            source="integration_sdk"
            href="https://github.com/jhonsfran/chatbot/blob/main/lib/unprice/runtime.ts"
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-sm font-medium text-background-textContrast",
              focusRing
            )}
          >
            Read the chatbot integration
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
