import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { siteConfig } from "~/constants/layout"
import { DEMO_VIDEO } from "./demo-video"
import { ProofLink } from "./proof-link"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

const REPO_URL = siteConfig.links.github
const DO_TEST_PATH = "apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts"

// Proof that does not depend on us publishing anything. Every row is a real
// artifact in the repo, and every one can be run by a reader who believes
// nothing on this page. The concurrency row is not a claim about what Redis
// cannot do — an atomic script handles this fine, and saying otherwise is how
// the page loses the one reader who has written one. It is evidence that our
// own enforcement holds: five concurrent over-limit writes, partitioned, in
// the real Workers runtime.
const receipts = [
  {
    label: "AI chatbot",
    fact: "reserve before generation · settle actual token usage on finish",
    href: "https://github.com/jhonsfran/chatbot/blob/main/lib/unprice/runtime.ts",
    linkLabel: "Read the integration",
    source: "demo_source" as const,
  },
  {
    label: "concurrency",
    fact: "5 concurrent over-limit writes → 2 accepted, 3 rejected",
    href: `${REPO_URL}/blob/main/${DO_TEST_PATH}`,
    linkLabel: "Read the test",
    source: "demo_source" as const,
  },
  {
    label: "latency",
    fact: "k6 harness · run it against your own deployment",
    href: `${REPO_URL}/tree/main/tooling/k6`,
    linkLabel: "Run the benchmark",
    source: "demo_benchmark" as const,
  },
  {
    label: "the money path",
    fact: "AGPL-3.0 · the decision, ledger, and wallet code",
    href: REPO_URL,
    linkLabel: "Read the source",
    source: "demo_source" as const,
  },
]

const shotList = [
  { label: "01", fact: "one customer · a $1.00 budget" },
  { label: "02", fact: "$0.60 reserved before the provider call" },
  { label: "03", fact: "$0.40 settled as actual spend" },
  { label: "04", fact: "$0.20 released · $0.60 available again" },
  { label: "05", fact: "$0.80 request denied · no provider call" },
]

function VideoBlock() {
  return (
    <figure className="w-full max-w-3xl rounded-lg border border-background-border bg-surface-raised p-4 shadow-ambient sm:p-5">
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          How spend authorization works
        </span>
        <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
          34 seconds · animated example
        </span>
      </figcaption>
      <video
        aria-label="How Unprice spend authorization works, an animated example"
        controls
        playsInline
        preload="none"
        width={1280}
        height={720}
        poster={DEMO_VIDEO.poster}
        src={DEMO_VIDEO.src}
        className="aspect-video w-full rounded-sm bg-background-bg"
      >
        <track kind="captions" src={DEMO_VIDEO.captions} srcLang="en" label="English" default />
      </video>
      <div className="mt-4 flex flex-col border-background-border border-t pt-2">
        {shotList.map((row) => (
          <LedgerRow
            key={row.fact}
            label={row.label}
            variant="ghost"
            fact={row.fact}
            labelClassName="font-mono text-xs"
          />
        ))}
      </div>
    </figure>
  )
}

export function DemoSection() {
  return (
    <SectionShell id="demo" labelledBy="demo-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="The proof" fact="check it without us" />
        <h2
          id="demo-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Watch the explanation. Read the proof.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          The animation explains reservation, settlement, and denial. Check the implementation with
          the tests, benchmark, and source below.
        </p>
      </div>

      <div className="mt-12 flex flex-col gap-8">
        <VideoBlock />

        <div className="flex w-full max-w-3xl flex-col border-background-border border-t">
          {receipts.map((row) => (
            <div
              key={row.label}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-background-border border-b py-4"
            >
              <span className="min-w-28 font-mono text-background-text text-xs uppercase tracking-widest">
                {row.label}
              </span>
              <span className="flex-1 text-background-text text-sm leading-6">{row.fact}</span>
              <ProofLink
                source={row.source}
                href={row.href}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "group inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-sm font-medium text-background-textContrast text-sm",
                  focusRing
                )}
              >
                {row.linkLabel}
                <ArrowRight
                  aria-hidden
                  className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
                />
              </ProofLink>
            </div>
          ))}
        </div>
      </div>
    </SectionShell>
  )
}
