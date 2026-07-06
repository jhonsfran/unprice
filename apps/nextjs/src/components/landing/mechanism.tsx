import { Ban, Check } from "lucide-react"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// The mechanism, stated as the five questions the money path answers before
// any cost exists. Deliberately mirrors the problem section: the same five
// facts that were "unknown / never ran" in the DIY trace are answered here,
// in the request path, with the runtime call that answers them.

const preflightQuestions = [
  { question: "Which plan version applies?", fact: "pro@v3 · pinned" },
  { question: "Is the customer entitled?", fact: "access.check · ok" },
  { question: "Which meter rule rates it?", fact: "tokens_used · $0.002 / token" },
  { question: "Do wallet credits cover it?", fact: "reserve −1 credit" },
  { question: "Is there budget left?", fact: "$4.10 remaining" },
]

export function MechanismSection() {
  return (
    <SectionShell labelledBy="mechanism-title">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:gap-16">
        <div className="order-first flex flex-col lg:order-none">
          <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              Pre-flight
            </span>
            <span className="font-mono text-[10px] text-background-text">
              answered before cost exists
            </span>
          </div>

          <div className="mt-3 flex flex-col">
            {preflightQuestions.map((row) => (
              <LedgerRow key={row.question} label={row.question} fact={row.fact} />
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5 rounded-sm border border-success-border bg-success-bg px-3 py-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-success-solid text-white">
                <Check aria-hidden className="size-3.5" />
              </span>
              <div className="flex flex-1 items-baseline justify-between gap-2">
                <p className="font-medium text-background-textContrast text-sm">
                  every answer yes · work runs
                </p>
                <p className="font-mono text-[11px] text-success-text">200</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-sm border border-danger-border bg-danger-bg px-3 py-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-danger-solid text-white">
                <Ban aria-hidden className="size-3.5" />
              </span>
              <div className="flex flex-1 items-baseline justify-between gap-2">
                <p className="font-medium text-background-textContrast text-sm">
                  any answer no · denied first
                </p>
                <p className="font-mono text-[11px] text-danger-text">429 LIMIT_EXCEEDED</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start">
          <StationHeader label="The mechanism" fact="deny · before cost" />
          <h2
            id="mechanism-title"
            className="mt-6 max-w-xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
          >
            Customer spend authorization runs in the request path.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Before the paid action runs, your app asks one money path which plan version applies,
            whether the customer is entitled, whether the budget or wallet has room, and whether the
            decision can explain the invoice line later.
          </p>
          <p className="mt-4 max-w-xl text-background-text text-sm leading-6">
            One decision, two futures. A deny is a{" "}
            <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[11px] text-background-textContrast">
              429
            </code>{" "}
            before any cost exists — the wallet untouched, the ledger empty, the invoice clean. An
            allow keeps the evidence that explains the invoice line, from the same decision that let
            the work run.
          </p>
        </div>
      </div>
    </SectionShell>
  )
}
