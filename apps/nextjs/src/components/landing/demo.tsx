import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight, Play } from "lucide-react"
import { ProofLink } from "./proof-link"
import { LedgerRow, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 03 exists because every other artifact on this page is drawn by us.
// The diagram above is a claim about what the runtime does; this station is
// where that claim gets checked by someone who does not trust us yet.
//
// TO SHIP THE VIDEO: set DEMO_VIDEO to the recording. Nothing else changes —
// the placeholder frame below is replaced by the player and the poster still
// carries the same receipt. Everything under it (source, benchmark) is true
// and clickable today, so the station is never empty of proof while the
// recording is outstanding.

const REPO_URL = "https://github.com/jhonsfran1165/unprice"

// `captions` is required on purpose: a recording that ships without a caption
// track is not finished, and making it part of the type means nobody has to
// remember.
const DEMO_VIDEO: { src: string; captions: string; poster?: string } | null = null

// What the recording has to show, in order. This is also the shot list — the
// video is the same five moments the reader just watched as a diagram, done
// once, unedited, against a real Sandbox project.
const shotList = [
  { label: "01", fact: "one plan version · created in the dashboard" },
  { label: "02", fact: "customers.signUp · one test customer" },
  { label: "03", fact: "access.check · beside the existing logic" },
  { label: "04", fact: "the third request · LIMIT_EXCEEDED" },
  { label: "05", fact: "the ledger entry that never got written" },
]

function VideoFrame() {
  if (DEMO_VIDEO) {
    return (
      <video
        controls
        preload="none"
        poster={DEMO_VIDEO.poster}
        src={DEMO_VIDEO.src}
        className="aspect-video w-full rounded-sm bg-background-bg"
      >
        <track kind="captions" src={DEMO_VIDEO.captions} srcLang="en" label="English" default />
      </video>
    )
  }

  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-sm border border-background-border border-dashed bg-background-bg">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full border border-background-borderHover"
      >
        <Play className="size-4 translate-x-px text-background-text" />
      </span>
      <p className="px-6 text-center text-background-text text-sm leading-6">
        One unedited run, recorded against a real Sandbox project.
      </p>
      <p className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        recording · not yet published
      </p>
    </div>
  )
}

export function DemoSection() {
  return (
    <SectionShell id="demo" labelledBy="demo-title" surface="panel">
      <div className="flex flex-col items-start">
        <StationHeader index="03" label="See it run" fact="unedited · one take" />
        <h2
          id="demo-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          Watch a real request get denied.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Everything above this line is drawn by us. This is the same path, run once against a real
          Sandbox project — plan version, customer, check, denial, and the ledger entry that never
          got written.
        </p>
      </div>

      <figure className="mt-12 w-full max-w-3xl rounded-lg border border-background-border bg-surface-raised p-4 shadow-ambient sm:p-5">
        <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
          <span className="font-mono text-background-text text-xs uppercase tracking-widest">
            One paid action · one afternoon
          </span>
          <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
            sandbox · no processor
          </span>
        </figcaption>

        <VideoFrame />

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

      {/* Proof that does not depend on a recording: both of these are true
          and checkable right now, by a reader who trusts nothing on the page. */}
      <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3">
        <ProofLink
          source="demo_source"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "group inline-flex items-baseline gap-1.5 rounded-sm font-medium text-background-textContrast text-sm",
            focusRing
          )}
        >
          Read the money-path source
          <ArrowRight
            aria-hidden
            className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
          />
        </ProofLink>
        <ProofLink
          source="demo_benchmark"
          href={`${REPO_URL}/tree/main/tooling/k6`}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "group inline-flex items-baseline gap-1.5 rounded-sm font-medium text-background-textContrast text-sm",
            focusRing
          )}
        >
          Run the benchmark yourself
          <ArrowRight
            aria-hidden
            className="size-3 self-center transition-transform duration-quick ease-out-quad group-hover:translate-x-0.5"
          />
        </ProofLink>
      </div>
    </SectionShell>
  )
}
