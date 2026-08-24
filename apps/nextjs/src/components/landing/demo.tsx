import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight, Play } from "lucide-react"
import { DEMO_VIDEO } from "./demo-video"
import { ProofLink } from "./proof-link"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 03 exists because every other artifact on this page is drawn by us.
// The diagram above is a claim about what the runtime does; this station is
// where that claim gets checked by someone who does not trust us yet.
//
// The recording is the eventual centrepiece, but it is not the only proof and
// it must not be the only thing here — a station whose entire content is a
// "coming soon" frame reads as a shell, and the one reader who dug into the
// repo trusted a concurrency test more than anything on the page. So the
// receipts that are true and clickable *today* lead, and the video slots in
// above them when it lands. Configuration lives in demo-video.ts.

const REPO_URL = "https://github.com/jhonsfran1165/unprice"
const DO_TEST_PATH = "apps/api/src/ingestion/entitlements/EntitlementWindowDO.workers.test.ts"

// Proof that does not depend on us publishing anything. Every row is a real
// artifact in the repo, and every one can be run by a reader who believes
// nothing on this page. The first is the invariant a Redis counter breaks:
// five concurrent over-limit writes, partitioned, in the real Workers runtime.
const receipts = [
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
    fact: "AGPL-3.0 · ledger, wallet, and decision in the open",
    href: REPO_URL,
    linkLabel: "Read the source",
    source: "demo_source" as const,
  },
]

// What the recording shows, in order — the same five moments the reader just
// watched as a diagram, done once, unedited, against a real Sandbox project.
const shotList = [
  { label: "01", fact: "one plan version · created in the dashboard" },
  { label: "02", fact: "customers.signUp · one test customer" },
  { label: "03", fact: "access.check · beside the existing logic" },
  { label: "04", fact: "the third request · LIMIT_EXCEEDED" },
  { label: "05", fact: "the ledger entry that never got written" },
]

function VideoBlock() {
  if (DEMO_VIDEO) {
    return (
      <figure className="w-full max-w-3xl rounded-lg border border-background-border bg-surface-raised p-4 shadow-ambient sm:p-5">
        <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            One paid action · one afternoon
          </span>
          <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
            sandbox · no processor
          </span>
        </figcaption>
        <video
          controls
          preload="none"
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

  // No recording yet: say so in one quiet line rather than building a station
  // around an empty player. The receipts below are the proof until it lands.
  return (
    <div className="flex w-full max-w-3xl items-baseline gap-3 rounded-lg border border-background-border border-dashed px-4 py-3">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center self-center rounded-full border border-background-borderHover"
      >
        <Play className="size-2.5 translate-x-px text-background-text" />
      </span>
      <p className="text-background-text text-sm leading-6">
        A recorded walkthrough is coming. Until it does, the receipts below are the ones you can
        check yourself. You do not need an account or a demo call.
      </p>
    </div>
  )
}

export function DemoSection() {
  return (
    <SectionShell id="demo" labelledBy="demo-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="The receipts" fact="checkable · without us" />
        <h2
          id="demo-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Read the proof.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Read the concurrency test, run the benchmark against your deployment, and inspect the
          money-path source. If the ledger does not balance, the source and tests will show it.
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
