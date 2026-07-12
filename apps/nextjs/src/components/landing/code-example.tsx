import { IntegrationLadder } from "./integration-ladder"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Developer proof: the first integration stays two calls — the honest
// minimum, and the claim the guarantee is written against — but the rest of
// the money path is no longer a footnote. The ladder (gate → meter →
// budget) makes the escalation visible without raising the entry bar: the
// default tab is still the two-call gate. Snippets live in
// integration-ladder.tsx; the shadow → enforce story lives in adoption.

export default function CodeExample() {
  return (
    <SectionShell labelledBy="code-example-title">
      <div className="flex flex-col items-start">
        <StationHeader
          index="03"
          label="First integration"
          fact="two calls to gate · three to bill · four to cap"
        />
        <h2
          id="code-example-title"
          className="mt-6 max-w-xl font-primary text-background-textContrast text-display-3"
        >
          The first integration is two calls.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            customers.signUp
          </code>{" "}
          once, at your own signup — it returns the customerId you store — then{" "}
          <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[13px] text-background-textContrast">
            access.check
          </code>{" "}
          in front of the paid action on every request. One more call meters what ran. One more puts
          a budget around a whole job or agent. Nothing has to block production traffic on day one.
        </p>
      </div>

      <IntegrationLadder />
    </SectionShell>
  )
}
