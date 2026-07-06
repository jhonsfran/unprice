import { SDKDemo } from "./sdk-examples"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Developer proof: the real SDK surface, not a mock terminal. The ladder on
// the right is the escalation path — every call is public API today.

const callLadder = [
  { label: "access.check", fact: "shadow · read-only" },
  { label: "usage.record", fact: "evidence · non-blocking" },
  { label: "usage.consume", fact: "enforcement · in-flight" },
  { label: "runs.start / consume / end", fact: "budget envelopes" },
]

export default function CodeExample() {
  return (
    <SectionShell labelledBy="code-example-title">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-16">
        <div className="flex flex-col items-start">
          <StationHeader label="First integration" fact="access.check · one call" />
          <h2
            id="code-example-title"
            className="mt-6 max-w-xl font-primary font-semibold text-3xl text-background-textContrast tracking-tight sm:text-4xl"
          >
            The first request path is deliberately small.
          </h2>
          <p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
            Define one plan version, provision or map one customer, then run{" "}
            <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
              access.check
            </code>{" "}
            next to the code you already trust. Nothing has to block production traffic on day one.
          </p>
          <p className="mt-4 max-w-xl text-background-text text-sm leading-6">
            Once the decision matches the evidence, switch to synchronous enforcement or budgeted
            workflows. The same path that denies over-budget work keeps the invoice explanation.
          </p>
        </div>

        <div className="flex h-fit flex-col lg:mt-2">
          <div className="flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The escalation path
            </span>
            <span className="font-mono text-[10px] text-background-text">public SDK · today</span>
          </div>
          <div className="mt-3 flex flex-col">
            {callLadder.map((row) => (
              <LedgerRow
                key={row.label}
                label={<span className="font-mono text-xs">{row.label}</span>}
                fact={row.fact}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-12">
        <SDKDemo
          presentation="panel"
          showBorderBeam={false}
          className="mx-0 mt-0 max-w-none"
          methods={[
            "checkAccess",
            "signUpCustomer",
            "recordUsage",
            "consumeUsage",
            "startBudgetedRun",
            "explainCharge",
          ]}
        />
      </div>
    </SectionShell>
  )
}
