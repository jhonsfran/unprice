import { SDKDemo } from "./sdk-examples"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Developer proof: the real SDK surface, not a mock terminal. One proof, not
// two — the escalation story (shadow → enforce) lives in the adoption section.

export default function CodeExample() {
  return (
    <SectionShell labelledBy="code-example-title">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="First integration" fact="access.check · one call" />
        <h2
          id="code-example-title"
          className="mt-6 max-w-xl font-primary text-background-textContrast text-display-3"
        >
          The first request path is deliberately small.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Define one plan version, provision or map one customer, then run{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            access.check
          </code>{" "}
          next to the code you already trust. Nothing has to block production traffic on day one.
        </p>
      </div>

      <div className="mt-12">
        <SDKDemo
          methods={[
            "signUpCustomer",
            "checkAccess",
            "consumeUsage",
            "startBudgetedRun",
            "explainCharge",
          ]}
        />
      </div>
    </SectionShell>
  )
}
