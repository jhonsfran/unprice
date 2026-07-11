"use client"

import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Reveal } from "../reveal"
import { SectionShell } from "../station"
import { StationHeader } from "../station-header"
import {
  BASE_FEE,
  DEFAULT_FEATURES,
  type Decision,
  type Feature,
  featureCost,
  marginalCharge,
} from "./model"
import { PanelFrame, PlanPanel } from "./plan-panel"
import { DecisionReceipt, InvoiceReceipt } from "./receipt"

// Station 03: the money path, driven by hand. The hero animates one request
// end to end; here the reader fires the request themselves. Left panel is the
// customer's plan sheet (each paid action a clickable ledger row), the right
// panel is the decision receipt the runtime returns — the same allow/deny
// chips, evidence rows, and ghost-absence grammar the money path uses. One
// info dot carries each click across the labeled request/decision boundary.
// Every fact rendered is real demo state; the deny branch proves itself by
// what it does NOT create.

// Between the panels: the boundary every request crosses. Same connector
// grammar as the system map, so the page's diagrams and its demo agree on
// what an edge looks like.
function BoundaryConnector() {
  return (
    <div aria-hidden>
      <div className="hidden flex-col items-center gap-1 self-center px-1.5 lg:flex">
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          request
        </span>
        <div
          data-dd-line
          className="relative h-px w-full border-background-borderHover border-t border-dashed"
        >
          <span className="-left-0.5 -top-[3px] absolute size-[7px] rounded-full bg-background-borderHover" />
          <span className="-right-0.5 -top-[3px] absolute size-[7px] rounded-full bg-background-borderHover" />
        </div>
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          decision
        </span>
      </div>
      <div className="flex items-center justify-center gap-2 py-1.5 lg:hidden">
        <span className="h-7 w-0 border-background-borderHover border-l border-dashed" />
        <span className="font-mono text-[9px] text-background-text uppercase tracking-widest">
          request · decision
        </span>
      </div>
    </div>
  )
}

export function DecisionDemo({ className }: { className?: string }) {
  const [features, setFeatures] = useState<Feature[]>(DEFAULT_FEATURES)
  const [lastDecision, setLastDecision] = useState<Decision | null>(null)
  const [acceptedActions, setAcceptedActions] = useState(0)
  const [view, setView] = useState<"decision" | "invoice">("decision")
  const [hitRowId, setHitRowId] = useState<string | null>(null)
  const [chipHit, setChipHit] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const receiptRef = useRef<HTMLDivElement>(null)
  const flightRef = useRef<Animation | null>(null)
  const rowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const chipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      flightRef.current?.cancel()
      if (rowTimer.current) clearTimeout(rowTimer.current)
      if (chipTimer.current) clearTimeout(chipTimer.current)
    }
  }, [])

  const metered = features.reduce((sum, f) => sum + featureCost(f), 0)
  const acceptedSpend = BASE_FEE + metered
  const lastFeature = lastDecision
    ? (features.find((f) => f.id === lastDecision.featureId) ?? null)
    : null

  // The request in flight: one quick hop across the boundary connector — the
  // clicked row's dot flashes at the source, the dot crosses the dashed rail
  // in under a quarter second, and the outcome chip's highlight carries the
  // arrival. Rails only, and fast enough to read as the click's echo.
  const launchFlight = useCallback((featureId: string) => {
    setHitRowId(featureId)
    if (rowTimer.current) clearTimeout(rowTimer.current)
    rowTimer.current = setTimeout(() => setHitRowId(null), 420)

    const land = () => {
      setChipHit(true)
      if (chipTimer.current) clearTimeout(chipTimer.current)
      chipTimer.current = setTimeout(() => setChipHit(false), 520)
    }

    const stage = stageRef.current
    if (!stage || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      land()
      return
    }
    const dot = stage.querySelector<HTMLElement>("[data-dd-dot]")
    const line = stage.querySelector<HTMLElement>("[data-dd-line]")
    const lineBox = line?.getBoundingClientRect()
    if (!dot || !lineBox || lineBox.width === 0) {
      // Stacked layout: no horizontal boundary to travel — the chip flash and
      // the scroll-into-view carry the moment.
      land()
      return
    }

    const stageBox = stage.getBoundingClientRect()
    const y = lineBox.top - stageBox.top + lineBox.height / 2
    const x0 = lineBox.left - stageBox.left + 2
    const x1 = lineBox.right - stageBox.left - 2

    const FADE = 60
    const travel = Math.max(70, (x1 - x0) / 1.1)
    const total = FADE + travel + FADE
    const frame = (x: number, o: number, offset: number) => ({
      transform: `translate3d(${(x - 4.5).toFixed(1)}px, ${(y - 4.5).toFixed(1)}px, 0)`,
      opacity: o,
      offset,
    })

    const keyframes = [
      frame(x0, 0, 0),
      frame(x0, 1, FADE / total),
      frame(x1, 1, (FADE + travel) / total),
      frame(x1, 0, 1),
    ]

    flightRef.current?.cancel()
    const anim = dot.animate(keyframes, { duration: total, easing: "linear" })
    flightRef.current = anim
    // A cancelled flight (rapid clicks) never lands — the newer request does.
    anim.finished.then(land).catch(() => {})
  }, [])

  const handleFire = useCallback(
    (featureId: string) => {
      const feature = features.find((f) => f.id === featureId)
      if (!feature) return

      const nextUsage = feature.usage + 1
      const overLimit = nextUsage > feature.config.limit
      const seq = (lastDecision?.seq ?? 0) + 1

      let decision: Decision
      if (feature.type === "flat" && feature.usage > 0) {
        decision = { kind: "allow", featureId, charge: 0, reason: "already_included", seq }
      } else if (overLimit && feature.config.limitType === "hard" && feature.type !== "flat") {
        decision = { kind: "deny", featureId, charge: 0, reason: "limit_exceeded", seq }
      } else {
        decision = {
          kind: overLimit && feature.type !== "flat" ? "warn" : "allow",
          featureId,
          charge: marginalCharge(feature, nextUsage),
          reason: overLimit && feature.type !== "flat" ? "soft_limit_crossed" : "within_budget",
          seq,
        }
      }

      // Denies and covered repeats (access.check on an active seat) consume
      // nothing — only accepted metered work moves the counters.
      if (decision.kind !== "deny" && decision.reason !== "already_included") {
        setFeatures((prev) =>
          prev.map((f) => (f.id === featureId ? { ...f, usage: f.usage + 1 } : f))
        )
        setAcceptedActions((prev) => prev + 1)
      }

      // Never steal the reader's tab: the invoice view accrues live, and the
      // decision view updates in place for whoever is watching it.
      setLastDecision(decision)
      launchFlight(featureId)

      // On stacked layouts the receipt renders below the plan; bring the
      // guardrail moment into view when it fires.
      if (decision.kind !== "allow") {
        requestAnimationFrame(() => {
          const panel = receiptRef.current
          if (!panel) return
          if (panel.getBoundingClientRect().top > window.innerHeight * 0.6) {
            panel.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
              block: "start",
            })
          }
        })
      }
    },
    [features, lastDecision, launchFlight]
  )

  const handleReset = useCallback(() => {
    flightRef.current?.cancel()
    setFeatures(DEFAULT_FEATURES)
    setLastDecision(null)
    setAcceptedActions(0)
    setView("decision")
    setHitRowId(null)
    setChipHit(false)
  }, [])

  return (
    <SectionShell id="demo" labelledBy="decision-demo-title" className={className}>
      <div className="max-w-2xl">
        <StationHeader index="02" label="The decision, live" fact="you send the request" />
        <h2
          id="decision-demo-title"
          className="mt-6 font-primary text-background-textContrast text-display-3"
        >
          Watch paid work stop before it creates cost.
        </h2>
        <p className="mt-5 text-background-text text-base leading-7 sm:text-lg sm:leading-8">
          Click a paid action against the plan. Each request is allowed, flagged, or denied before
          the work runs — and the same decision explains the invoice line later.
        </p>
      </div>

      <figure
        aria-label="An interactive plan sheet for acme-corp on pro@v3. The left panel lists the plan's paid actions — API requests and tiered storage behind hard guardrails, budgeted compute behind a soft one, and a flat premium support seat — each with a live usage meter. Clicking a paid action sends one request across the request/decision boundary to the decision receipt, which answers allow, flagged, or deny before the work runs, with the evidence kept with the decision: the call, plan version, pricing rule, guardrail, and remaining budget. A hard-limited row stays clickable, and every further click is denied showing what it did not create — work never ran, no charge, no ledger entry, no invoice line. The receipt's invoice view accrues the accepted charges into the invoice each decision explains."
        className="mt-10 sm:mt-12"
      >
        <Reveal>
          <div
            ref={stageRef}
            className="relative grid grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)] lg:gap-0"
          >
            {/* Plan sheet: the request side of the boundary */}
            <PlanPanel
              features={features}
              hitRowId={hitRowId}
              metered={metered}
              acceptedSpend={acceptedSpend}
              acceptedActions={acceptedActions}
              onFire={handleFire}
              onReset={handleReset}
            />

            <BoundaryConnector />

            {/* Decision receipt: the product's side of the boundary. The
                bracket corners are the logo's containment motif — the one
                place on the sheet where the commercial decision happens. */}
            <div ref={receiptRef} className="scroll-mt-20">
              <PanelFrame className="relative border-background-borderHover shadow-raised">
                <span
                  aria-hidden
                  className="-top-px -left-px absolute size-3 border-primary-text border-t-2 border-l-2"
                />
                <span
                  aria-hidden
                  className="-top-px -right-px absolute size-3 border-primary-text border-t-2 border-r-2"
                />
                <span
                  aria-hidden
                  className="-bottom-px -left-px absolute size-3 border-primary-text border-b-2 border-l-2"
                />
                <span
                  aria-hidden
                  className="-bottom-px -right-px absolute size-3 border-primary-text border-r-2 border-b-2"
                />

                <div className="flex items-baseline justify-between gap-3 border-background-border border-b px-4 py-3 sm:px-5">
                  <fieldset className="-ml-2 flex items-baseline gap-1">
                    <legend className="sr-only">Receipt view</legend>
                    {(["decision", "invoice"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setView(tab)}
                        aria-pressed={view === tab}
                        className={cn(
                          "rounded-[3px] px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest transition-colors duration-quick ease-out-quad",
                          focusRing,
                          view === tab
                            ? "bg-background-bgActive text-background-textContrast"
                            : "text-background-text hover:text-background-textContrast"
                        )}
                      >
                        {tab === "decision" ? "Decision trail" : "Invoice"}
                      </button>
                    ))}
                  </fieldset>
                  <span className="font-mono text-[10px] text-background-text tabular-nums">
                    {lastDecision ? `request #${lastDecision.seq}` : "no request yet"}
                  </span>
                </div>

                <div className="flex flex-1 flex-col px-4 py-4 sm:px-5">
                  {view === "decision" ? (
                    <DecisionReceipt decision={lastDecision} feature={lastFeature} chipHit={chipHit} />
                  ) : (
                    <InvoiceReceipt features={features} />
                  )}
                </div>
              </PanelFrame>
            </div>

            {/* the request in flight — launched per click, rails only */}
            <span
              aria-hidden
              data-dd-dot
              className="pointer-events-none absolute top-0 left-0 size-[9px] rounded-full bg-info opacity-0 will-change-transform"
            />
          </div>
        </Reveal>

        <figcaption className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          <span>
            The demo curates the response — every fact on the receipt is a field the API returns.
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
            Read the docs
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
