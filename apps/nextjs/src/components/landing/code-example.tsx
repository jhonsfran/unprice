import { API_DOMAIN } from "@unprice/config"
import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { CodeEditor } from "./code-editor"
import CopyToClipboard from "./copy-to-clipboard"
import { SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Developer proof: one real call, shown whole. The section's claim is that
// the first request path is deliberately small, so it argues with a single
// snippet — no tabs, no framework switcher. The full SDK surface belongs to
// the docs; the escalation story (shadow → enforce) lives in adoption.

const API_BASE_URL = API_DOMAIN.replace(/\/$/, "")

const CHECK_ACCESS_SNIPPET = `import { Unprice } from "@unprice/api"

const unprice = new Unprice({
  token: process.env.UNPRICE_TOKEN,
  baseUrl: "${API_BASE_URL}",
})

// Check access before the paid action runs.
const { result, error } = await unprice.access.check({
  customerId: "cus_1GTzSGrapiBW1QwCL3Fcn",
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

      <figure
        aria-label="The complete first integration: create the Unprice client, call access.check for a customer and feature, stop on the denied branch before any cost exists, and run the paid action on allow — the same decision explains the invoice line later."
        className="mt-12 max-w-3xl"
      >
        <div className="rounded-lg border border-background-border bg-surface-panel shadow-ambient">
          <div className="flex items-center justify-between gap-4 border-background-border border-b px-4 py-2 sm:px-5">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              access.check
            </span>
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-[10px] text-background-text sm:inline">
                TypeScript SDK · the whole first integration
              </span>
              <CopyToClipboard code={CHECK_ACCESS_SNIPPET} variant="ghost" className="size-7" />
            </div>
          </div>
          <div className="overflow-x-auto px-4 py-4 sm:px-5">
            <CodeEditor codeBlock={CHECK_ACCESS_SNIPPET} language="typescript" />
          </div>
        </div>
        <figcaption className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          <span>
            One call shown; the rest of the money path —{" "}
            <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[11px] text-background-textContrast">
              usage.consume
            </code>
            , budgeted runs, invoice evidence — lives in the docs.
          </span>
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
    </SectionShell>
  )
}
