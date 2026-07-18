import { cn } from "@unprice/ui/utils"
import { Reveal } from "./reveal"
import { Leader, SectionShell } from "./station"
import { StationHeader } from "./station-header"

// Station 02, the business floor: why this system and not the adjacent ones —
// rendered as state, not argued in prose. The money story is five stops
// (decide · meter · invoice · explain · own); each adjacent system covers the
// stops it covers, drawn as solid dots joined by rail segments, and misses
// the rest as ghost dots — the matrix version of the money path's deny
// branch, absence as proof. Unprice is the only unbroken rail. Category
// claims only (gateways cap provider spend, metering bills after the fact,
// DIY runs the work first) — the same boundaries the FAQ states, no named
// vendors. Legibility round (2026-07-18 critique: the chart decoded too
// slowly): every row carries its verdict as a mono fact so nobody has to
// count dots, and the winning row is the one lifted element in the panel.

const stops = ["decide", "meter", "invoice", "explain", "own"]

type SystemRow = {
  name: string
  clause: string
  /** Which stops of the money story this system runs, in `stops` order. */
  covered: boolean[]
  /** The row's one-glance verdict — stated, so the rail never has to be
   * decoded to be believed. */
  verdict: string
  self?: boolean
}

const systems: SystemRow[] = [
  {
    name: "DIY counter",
    clause: "the work runs before any check",
    covered: [false, true, true, false, true],
    verdict: "3 of 5 stops",
  },
  {
    name: "Spend gateway",
    clause: "caps your provider bill, not your customer's",
    covered: [true, true, false, false, false],
    verdict: "2 of 5 stops",
  },
  {
    name: "Metering + billing",
    clause: "bills after the work already ran",
    covered: [false, true, true, false, false],
    verdict: "2 of 5 stops",
  },
  {
    name: "Unprice",
    clause: "decides before the cost — in your accounts",
    covered: [true, true, true, true, true],
    verdict: "the only unbroken path",
    self: true,
  },
]

// Covered stops are solid dots; adjacent covered stops are joined by a rail
// segment, so partial systems read as fragments and Unprice reads as the one
// continuous path. Ghost dots mark the stops that never run.
function CoverageRail({ covered, self }: { covered: boolean[]; self?: boolean }) {
  return (
    <div aria-hidden className="flex items-center">
      {stops.map((stop, index) => {
        const on = covered[index] ?? false
        const next = covered[index + 1] ?? false
        return (
          <span key={stop} className="relative flex w-[var(--slot)] justify-center">
            {on && next ? (
              <span
                className={cn(
                  "-translate-y-1/2 absolute top-1/2 left-1/2 h-px w-[var(--slot)]",
                  self ? "bg-background-textContrast" : "bg-background-borderHover"
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative size-[9px] rounded-full",
                on
                  ? "bg-background-textContrast"
                  : "border border-background-borderHover border-dashed"
              )}
            />
          </span>
        )
      })}
    </div>
  )
}

export function UspSection() {
  return (
    <SectionShell labelledBy="usp-title">
      <div className="flex flex-col items-start">
        <StationHeader index="02" label="Why Unprice" fact="vs gateways · metering tools · DIY" />
        <h2
          id="usp-title"
          className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3"
        >
          The decision and the invoice are one system.
        </h2>
        <p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Gateways, meters, and billing tools each hold a piece of the story. Unprice runs the whole
          path — decision, evidence, invoice — in the open.
        </p>
      </div>

      <Reveal className="mt-12">
        <figure
          aria-label="Coverage of the money story across four systems. A DIY counter runs three of the five stops: it meters and invoices in your own code, but the work runs before any check and no line carries evidence. A spend gateway runs two of five: it decides and meters against your provider bill, but cannot invoice or explain your customer's charge. A metering and billing tool runs two of five: it meters and invoices after the work already ran, with no decision to attach. Unprice runs every stop — decide, meter, invoice, explain, own — open source, in your accounts: the only unbroken path."
          className="max-w-3xl rounded-lg border border-background-border bg-surface-panel p-4 shadow-ambient [--slot:3.25rem] sm:p-6 sm:[--slot:3.75rem]"
        >
          <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
            <span className="font-mono text-background-text text-xs uppercase tracking-widest">
              The money story<span className="hidden sm:inline"> · four systems</span>
            </span>
            <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
              ● runs it · ◌ never runs
            </span>
          </figcaption>

          <div
            aria-hidden
            className="flex border-background-border border-b pb-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6"
          >
            <span className="hidden sm:block" />
            <div className="flex">
              {stops.map((stop) => (
                <span
                  key={stop}
                  className="w-[var(--slot)] text-center font-mono text-[10px] text-background-text uppercase tracking-wide sm:text-[11px]"
                >
                  {stop}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col divide-y divide-background-border">
            {systems.map((system) => (
              <div
                key={system.name}
                className={cn(
                  "flex flex-col gap-3 py-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6",
                  // The winning row is the panel's one lifted element — the
                  // same center-of-gravity scarcity the money path uses.
                  system.self && "-mx-3 my-2 rounded-sm bg-surface-raised px-3 shadow-ambient"
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p
                      className={cn(
                        "whitespace-nowrap text-sm",
                        system.self
                          ? "font-medium text-background-textContrast"
                          : "text-background-text"
                      )}
                    >
                      {system.name}
                    </p>
                    <Leader />
                    {/* the verdict, stated — nobody should have to count
                        dots; amber only on the row that wins the decision */}
                    <span
                      className={cn(
                        "whitespace-nowrap font-mono text-[11px]",
                        system.self ? "font-medium text-primary-text" : "text-background-text"
                      )}
                    >
                      {system.verdict}
                    </span>
                  </div>
                  <p className="mt-0.5 text-background-text text-xs">{system.clause}</p>
                </div>
                <CoverageRail covered={system.covered} self={system.self} />
              </div>
            ))}
          </div>
        </figure>
      </Reveal>
    </SectionShell>
  )
}
