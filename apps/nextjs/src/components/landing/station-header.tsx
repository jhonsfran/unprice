"use client"

import { cn } from "@unprice/ui/utils"
import { useEffect, useRef, useState } from "react"
import { Leader } from "./station"

// The section opener is a StationRow at page scale — and the reader's scroll
// position is the request. While a section occupies the middle of the
// viewport its station dot lights up in the live-request `info` color, the
// same hit grammar the money path uses, so the whole page reads as one
// request walking the path. One IntersectionObserver per section against a
// narrow band around the viewport center; no scroll listeners, no rAF.

export function StationHeader({
  index,
  label,
  fact,
  factClassName,
}: {
  /** Station number on the page's request path, e.g. "01". The page is a
   * real sequence — request, decision, integration, adoption — so the
   * numbers carry reading order, not decoration. */
  index?: string
  label: string
  fact?: string
  factClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [lit, setLit] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scope = el.closest("section") ?? el
    const io = new IntersectionObserver(
      ([entry]) => setLit(entry?.isIntersecting ?? false),
      // A thin band around the viewport center: exactly one section spans it
      // at a time, so exactly one station is lit — the one being read.
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    )
    io.observe(scope)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} className="flex items-baseline gap-2.5">
      {/* Section titles are the page's table of contents — sized to be read,
          not decoded (management feedback 2026-07: the blue titles were too
          small to structure the page). */}
      <span
        aria-hidden
        className={cn(
          "size-[11px] shrink-0 self-center rounded-full transition-colors duration-regular ease-out-quad",
          lit
            ? "border border-info bg-info ring-2 ring-info-bg"
            : "border border-background-borderHover bg-surface-page"
        )}
      />
      {index ? (
        <span
          className={cn(
            "whitespace-nowrap font-mono text-sm tabular-nums tracking-widest transition-colors duration-regular ease-out-quad",
            lit ? "text-info-text" : "text-background-text"
          )}
        >
          {index}
        </span>
      ) : null}
      <span
        className={cn(
          "whitespace-nowrap font-mono text-sm uppercase tracking-widest transition-colors duration-regular ease-out-quad",
          lit ? "text-info-text" : "text-background-text"
        )}
      >
        {label}
      </span>
      {fact ? (
        <>
          <Leader className="hidden sm:block" />
          <span
            className={cn(
              "hidden whitespace-nowrap font-mono text-[11px] text-background-text sm:inline",
              factClassName
            )}
          >
            {fact}
          </span>
        </>
      ) : null}
    </div>
  )
}
