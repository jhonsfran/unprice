"use client"

import { Leader, StationDot } from "@unprice/ui/station"
import { cn } from "@unprice/ui/utils"
import { useEffect, useRef } from "react"

import { type RailStation, settledStationCount } from "./rail-state"

// The onboarding progress display is the money path itself: the same station
// grammar as the landing page, but driven by real mutation responses instead
// of a scripted pass. Ghost stations are the "before" tableau; each settled
// row is a fact written from a server response. Dots sit at the first-line
// center (top-[15px] = 5px padding + half a 20px text-sm line) so rows with
// sub-ledger entries keep the dot on their label line.

const DOT_TOP = "top-[15px]"

// Sub-rows and facts that settle after first render enter with the shared
// [data-reveal] grammar; anything already settled on mount renders static so
// reloads show the final state immediately (content visible by default).
function RevealOnMount({
  animate,
  stagger = false,
  className,
  children,
}: {
  animate: boolean
  stagger?: boolean
  className?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || el.getAttribute("data-reveal") !== "out") return
    const raf = requestAnimationFrame(() => el.setAttribute("data-reveal", "in"))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      ref={ref}
      data-reveal={animate ? "out" : undefined}
      data-reveal-stagger={animate && stagger ? "" : undefined}
      className={className}
    >
      {children}
    </div>
  )
}

function dotVariant(station: RailStation) {
  switch (station.status) {
    case "ghost":
      return "ghost" as const
    case "live":
      return "live" as const
    case "skipped":
      return "warning" as const
    case "failed":
      return "danger" as const
    case "denied":
      return "default" as const
    case "done":
      // The last station settling green is the landing's terminal grammar:
      // one green dot at the end of the path, not eight.
      return station.key === "check" ? ("terminal" as const) : ("default" as const)
  }
}

function factClassName(station: RailStation) {
  switch (station.status) {
    case "live":
      return "text-info-text"
    case "skipped":
      return "text-warning-text"
    case "failed":
    case "denied":
      return "text-danger-text"
    case "done":
      return station.key === "check" ? "text-success-text" : "text-background-text"
    default:
      return "text-background-text"
  }
}

function RailStationRow({
  station,
  isLast,
  animate,
}: {
  station: RailStation
  isLast: boolean
  animate: boolean
}) {
  const settled =
    station.status === "done" || station.status === "skipped" || station.status === "denied"

  return (
    <li
      className={cn("relative py-[5px] pl-8", station.status === "ghost" && "opacity-80")}
      aria-current={station.status === "live" ? "step" : undefined}
    >
      {/* Downward path to the next station: a dashed base that gets inked
          solid once this station's entry is written. */}
      {!isLast && (
        <>
          <span
            aria-hidden
            className="-translate-x-1/2 -bottom-[15px] absolute top-[15px] left-2 w-0 border-background-border border-l border-dashed"
          />
          <span
            aria-hidden
            className={cn(
              "-translate-x-1/2 -bottom-[15px] absolute top-[15px] left-2 w-px origin-top bg-background-borderHover transition-transform duration-deliberate ease-out-cubic motion-reduce:transition-none",
              settled ? "scale-y-100" : "scale-y-0"
            )}
          />
        </>
      )}

      <span
        aria-hidden
        className={cn("-translate-x-1/2 absolute left-2 block size-[9px]", DOT_TOP)}
      >
        {station.status === "live" && (
          <span className="mp-beacon absolute inset-0 rounded-full bg-info" />
        )}
        <StationDot
          variant={dotVariant(station)}
          className={cn(
            "absolute inset-0 transition-colors duration-regular ease-out-quad",
            dotVariant(station) === "default" && "bg-background-bgSubtle"
          )}
        />
      </span>

      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "whitespace-nowrap text-sm transition-colors duration-regular ease-out-quad",
            station.status === "ghost" && "text-background-text",
            station.status === "live" && "font-medium text-info-text",
            station.status !== "ghost" &&
              station.status !== "live" &&
              "font-medium text-background-textContrast"
          )}
        >
          {station.label}
        </span>
        <Leader />
        <span
          className={cn(
            "max-w-[55%] truncate font-mono text-[11px] leading-5 transition-colors duration-regular ease-out-quad",
            factClassName(station)
          )}
        >
          {station.fact}
        </span>
      </div>

      {station.subRows?.length ? (
        <RevealOnMount animate={animate} stagger>
          {station.subRows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-2 py-[2px]">
              <span className="text-background-text text-xs">{row.label}</span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                {row.fact}
              </span>
            </div>
          ))}
        </RevealOnMount>
      ) : null}
    </li>
  )
}

export function MoneyPathRail({ stations }: { stations: RailStation[] }) {
  const settled = settledStationCount(stations)

  // Stations already settled when the rail first mounted render static;
  // only entries written during this session animate in.
  const initiallySettledRef = useRef<Set<string> | null>(null)
  if (initiallySettledRef.current === null) {
    initiallySettledRef.current = new Set(
      stations
        .filter((s) => s.status === "done" || s.status === "skipped" || s.status === "denied")
        .map((s) => s.key)
    )
  }

  return (
    <figure aria-label="Sandbox money path" className="flex h-full flex-col">
      <figcaption className="mb-3 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          The money path
        </span>
        <span className="font-mono text-[10px] text-background-text tabular-nums">
          {settled}/{stations.length} settled
        </span>
      </figcaption>
      <ol className="m-0 list-none p-0">
        {stations.map((station, index) => (
          <RailStationRow
            key={station.key}
            station={station}
            isLast={index === stations.length - 1}
            animate={!initiallySettledRef.current?.has(station.key)}
          />
        ))}
      </ol>
    </figure>
  )
}
