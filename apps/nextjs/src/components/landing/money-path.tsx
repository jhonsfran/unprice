"use client"

import { cn } from "@unprice/ui/utils"
import { Ban, Check } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { AnimatedCounter } from "./animated-counter"

// The signature visual: the money path, rendered as one request traced end to
// end. The brand works when the buyer can see the commercial decision and the
// evidence trail (docs/brand/brand-identity.md, design-system-guidelines.md):
// receipt-style stations with monospace facts, the budget decision framed by
// the bracket motif from the logo, and a literal fork — the allow branch
// settles and explains; the deny branch shows the same stations untouched, so
// "rejected before any cost" is visible as the absence of state. Token-driven;
// motion is the sanctioned request-path education: a dot walks the path in two
// alternating passes that share one budget — the first request is allowed and
// its wallet reservation depletes the remaining budget to $0.00, so the next
// identical request is denied. Station titles light in the live-request
// `info` color as the dot passes. Removed under prefers-reduced-motion,
// started only when scrolled into view.

type Station = {
  id?: string
  label: string
  fact: string
}

const resolveStations: Station[] = [
  { id: "plan-version", label: "Plan version", fact: "pro@v3" },
  { id: "pricing-rule", label: "Pricing rule", fact: "$0.002 / token" },
  { id: "meter", label: "Meter", fact: "tokens_used" },
  { id: "entitlement", label: "Entitlement", fact: "access.check · ok" },
]

const settleStations: Station[] = [
  { id: "wallet", label: "Wallet", fact: "reserve −1 credit" },
  { id: "ledger", label: "Ledger", fact: "capture · balanced" },
  { id: "invoice", label: "Invoice", fact: "line explained" },
]

const ghostStations: Station[] = [
  { label: "Wallet", fact: "untouched" },
  { label: "Ledger", fact: "no entry" },
  { label: "Invoice", fact: "no line" },
]

// ---------------------------------------------------------------------------
// Request-path choreography. The dot walks measured waypoints along the rail:
// pass 1 is allowed and settles through wallet and ledger to the invoice —
// the reservation spends the remaining budget — so pass 2 arrives at a $0.00
// budget and ends rejected at the deny chip, before any cost. Highlights and
// the budget amount are driven from the same clock as the dot.
// ---------------------------------------------------------------------------

const BUDGET_START = 4.1
const BUDGET_DEPLETED = 0

const DOT_SIZE = 9
const TRAVEL_SPEED = 0.5 // px per ms along the rail
const FADE_MS = 140
const STATION_DWELL = 140 // pause on each station ring
const DECISION_DWELL = 260
const HIT_LINGER = 380 // how long a title stays lit after the dot arrives
const OUTCOME_LINGER = 1100
const PASS_GAP = 600
const RAIL_OFFSET_X = 8
const CHIP_CLEARANCE_Y = 6

type PassKind = "deny" | "allow"

type BuiltPass = {
  keyframes: Keyframe[]
  duration: number
  hits: { el: HTMLElement; at: number; until: number }[]
  // Budget updates on the same clock: the wallet reservation counts the
  // remaining budget down mid-pass; the next allow pass refills it.
  sets: { at: number; value: number; depleted: boolean }[]
}

function buildPass(root: HTMLElement, kind: PassKind): BuiltPass | null {
  const rootBox = root.getBoundingClientRect()
  if (rootBox.width === 0) return null

  const node = (name: string) => root.querySelector<HTMLElement>(`[data-mp-node="${name}"]`)
  const trace = root.querySelector<HTMLElement>("[data-mp-trace]")
  const request = node("request")
  const decision = node("decision")
  if (!trace || !request || !decision) return null

  // Measure the rendered rail dots themselves so the moving request stays
  // centered even when marker sizes differ between stations.
  const railDotCenter = (el: HTMLElement) => {
    const dot = el.querySelector<HTMLElement>("[data-mp-rail-dot]")
    if (!dot) return null
    const b = dot.getBoundingClientRect()
    return {
      x: b.left - rootBox.left + b.width / 2,
      y: b.top - rootBox.top + b.height / 2,
      size: b.width,
    }
  }
  const railPointOf = (el: HTMLElement) => {
    const dot = railDotCenter(el)
    if (dot) return dot
    const b = el.getBoundingClientRect()
    return {
      x: b.left - rootBox.left + RAIL_OFFSET_X,
      y: b.top - rootBox.top + b.height / 2,
      size: DOT_SIZE,
    }
  }
  const railXOf = (el: HTMLElement) =>
    railDotCenter(el)?.x ?? el.getBoundingClientRect().left - rootBox.left + RAIL_OFFSET_X

  const requestPoint = railPointOf(request)
  const railX = requestPoint.x
  const pts: { x: number; y: number; o: number; t: number; s: number }[] = []
  const hits: BuiltPass["hits"] = []
  const sets: BuiltPass["sets"] = []
  let t = 0

  const currentSize = () => pts[pts.length - 1]?.s ?? DOT_SIZE
  const jump = (x: number, y: number, o: number, ms: number, size = currentSize()) => {
    t += ms
    pts.push({ x, y, o, t, s: size })
  }
  const move = (x: number, y: number, size = currentSize()) => {
    const p = pts[pts.length - 1]
    if (p) t += Math.hypot(x - p.x, y - p.y) / TRAVEL_SPEED
    pts.push({ x, y, o: 1, t, s: size })
  }
  const dwell = (ms: number) => {
    const p = pts[pts.length - 1]
    if (!p) return
    t += ms
    pts.push({ x: p.x, y: p.y, o: p.o, t, s: p.s })
  }
  const hit = (el: HTMLElement | null, linger = HIT_LINGER) => {
    if (el) hits.push({ el, at: t, until: t + linger })
  }
  const fadeOut = () => {
    const p = pts[pts.length - 1]
    if (p) jump(p.x, p.y, 0, FADE_MS)
  }
  const setBudget = (value: number, depleted: boolean) => {
    sets.push({ at: t, value, depleted })
  }

  // A fresh allow pass is a fresh billing period: the budget refills as the
  // request spawns. A deny pass inherits the depleted budget of the pass
  // before it — that is why it is denied.
  setBudget(kind === "allow" ? BUDGET_START : BUDGET_DEPLETED, kind !== "allow")

  // Entry: the dot is emitted from the request station.
  pts.push({ x: requestPoint.x, y: requestPoint.y, o: 0, t: 0, s: requestPoint.size })
  jump(requestPoint.x, requestPoint.y, 1, FADE_MS, requestPoint.size)
  hit(request)
  dwell(STATION_DWELL)

  for (const name of ["plan-version", "pricing-rule", "meter", "entitlement"]) {
    const el = node(name)
    if (!el) continue
    const point = railPointOf(el)
    move(point.x, point.y, point.size)
    hit(el)
    dwell(STATION_DWELL)
  }

  const decisionPoint = railPointOf(decision)
  move(decisionPoint.x, decisionPoint.y, decisionPoint.size)
  hit(decision)
  dwell(DECISION_DWELL)

  if (kind === "deny") {
    const denyChip = node("deny-chip")
    if (!denyChip) return null
    const denyX = railXOf(denyChip)
    const denyTop = denyChip.getBoundingClientRect().top - rootBox.top
    const connector = root.querySelector<HTMLElement>("[data-mp-connector]")
    const hasBranch = connector && getComputedStyle(connector).display !== "none"

    if (hasBranch) {
      // Follow the drawn dashed branch: down, then across. The dot fades out
      // before entering the chip — the chip's own highlight carries the hit.
      const branchY = connector.getBoundingClientRect().top - rootBox.top + 12
      move(railX, branchY)
      move(denyX, branchY)
      move(denyX, denyTop - CHIP_CLEARANCE_Y)
    }
    // The dot never enters the chip; its highlight takes over.
    fadeOut()
    hit(denyChip, OUTCOME_LINGER)
    dwell(320)
  } else {
    const allowChip = node("allow-chip")
    if (!allowChip) return null
    // Fade out above the chip (the chip highlight is the signal), then
    // re-emerge directly on the first settle station.
    const chipBox = allowChip.getBoundingClientRect()
    const chipTop = chipBox.top - rootBox.top
    move(railX, chipTop - CHIP_CLEARANCE_Y)
    fadeOut()
    hit(allowChip, HIT_LINGER + 200)
    dwell(STATION_DWELL)

    for (const [index, name] of ["wallet", "ledger"].entries()) {
      const el = node(name)
      if (!el) continue
      const point = railPointOf(el)
      if (index === 0) {
        jump(point.x, point.y, 0, 40, point.size)
        jump(point.x, point.y, 1, FADE_MS, point.size)
      } else {
        move(point.x, point.y, point.size)
      }
      hit(el)
      // The reservation is the moment the money moves: the remaining budget
      // drops to zero as the wallet reserves.
      if (name === "wallet") setBudget(BUDGET_DEPLETED, true)
      dwell(STATION_DWELL)
    }

    const invoice = node("invoice")
    if (invoice) {
      const point = railPointOf(invoice)
      move(point.x, point.y, point.size)
      hit(invoice, OUTCOME_LINGER)
      dwell(320)
    }
    fadeOut()
  }

  const duration = t
  if (duration <= 0) return null
  const keyframes = pts.map((p) => ({
    transform: `translate3d(${(p.x - p.s / 2).toFixed(1)}px, ${(p.y - p.s / 2).toFixed(1)}px, 0)`,
    width: `${p.s}px`,
    height: `${p.s}px`,
    opacity: p.o,
    offset: Math.min(1, p.t / duration),
  }))
  return { keyframes, duration, hits, sets }
}

function Leader() {
  return (
    <span
      aria-hidden
      className="mx-1 min-w-4 flex-1 self-center border-background-border border-b border-dotted"
    />
  )
}

function StationRow({
  id,
  label,
  fact,
  variant = "default",
}: Station & { variant?: "default" | "ghost" | "terminal" }) {
  return (
    <div
      data-mp-node={id}
      className={cn("group relative py-[5px] pl-8", variant === "ghost" && "opacity-80")}
    >
      <span
        aria-hidden
        data-mp-rail-dot
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-2 size-[9px] rounded-full",
          variant === "default" && "border border-background-borderHover bg-surface-panel",
          variant === "ghost" && "border border-background-borderHover border-dashed",
          variant === "terminal" && "bg-success-solid"
        )}
      />
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "whitespace-nowrap text-sm transition-colors duration-regular ease-out-quad",
            variant === "ghost"
              ? "text-background-text"
              : "font-medium text-background-textContrast",
            "group-data-[mp-hit=true]:text-info-text"
          )}
        >
          {label}
        </span>
        <Leader />
        <span
          className={cn(
            "whitespace-nowrap font-mono text-[11px]",
            variant === "terminal" ? "text-success-text" : "text-background-text"
          )}
        >
          {fact}
        </span>
      </div>
    </div>
  )
}

function PhaseMarker({ children }: { children: string }) {
  return (
    <div aria-hidden className="relative py-1.5 pl-8">
      <span className="-translate-y-1/2 absolute top-1/2 left-2 h-px w-3 bg-background-border" />
      <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        {children}
      </span>
    </div>
  )
}

export function MoneyPath({ className }: { className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  // The remaining budget is real state, told on the choreography's clock:
  // the allow pass spends it to zero, the next period refills it.
  const [budget, setBudget] = useState({ value: BUDGET_START, depleted: false })

  useEffect(() => {
    const root = stageRef.current
    if (!root) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const dot = root.querySelector<HTMLElement>("[data-mp-dot]")
    if (!dot) return

    let cancelled = false
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let anim: Animation | null = null
    let hits: BuiltPass["hits"] = []
    let sets: BuiltPass["sets"] = []
    let setIndex = 0
    // Allow runs first and spends the budget; the deny that follows is its
    // consequence — the same request against a depleted budget.
    let pass: PassKind = "allow"

    const clearHits = () => {
      for (const h of hits) h.el.removeAttribute("data-mp-hit")
    }

    const tick = () => {
      if (anim) {
        const now = Number(anim.currentTime ?? 0)
        for (const h of hits) {
          if (now >= h.at && now <= h.until) h.el.setAttribute("data-mp-hit", "true")
          else if (h.el.hasAttribute("data-mp-hit")) h.el.removeAttribute("data-mp-hit")
        }
        while (setIndex < sets.length && now >= (sets[setIndex]?.at ?? Number.POSITIVE_INFINITY)) {
          const s = sets[setIndex]
          if (s) setBudget({ value: s.value, depleted: s.depleted })
          setIndex += 1
        }
      }
      raf = requestAnimationFrame(tick)
    }

    const runPass = () => {
      if (cancelled) return
      anim?.cancel()
      clearHits()
      const built = buildPass(root, pass)
      pass = pass === "deny" ? "allow" : "deny"
      if (!built) return
      hits = built.hits
      sets = built.sets
      setIndex = 0
      anim = dot.animate(built.keyframes, {
        duration: built.duration,
        easing: "linear",
        fill: "forwards",
      })
      anim.finished
        .then(() => {
          if (!cancelled) timer = setTimeout(runPass, PASS_GAP)
        })
        .catch(() => {})
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          io.disconnect()
          runPass()
          raf = requestAnimationFrame(tick)
        }
      },
      { threshold: 0.2 }
    )
    io.observe(root)

    return () => {
      cancelled = true
      io.disconnect()
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      anim?.cancel()
      clearHits()
      setBudget({ value: BUDGET_START, depleted: false })
    }
  }, [])

  return (
    <figure
      aria-label="The money path: one request traced end to end. A request resolves its plan version, pricing rule, meter, and entitlement, then reaches the budget decision. With $4.10 of budget remaining the request is allowed with a 200: the wallet reserves credits, the ledger captures the movement, and the invoice line is explained by the same decision. The reservation depletes the budget to $0.00, so the next identical request is denied with a 429 before any cost exists: the wallet is untouched, the ledger has no entry, and the invoice has no line."
      className={cn("mx-auto w-full max-w-3xl", className)}
    >
      <style>{`
        @keyframes mp-beacon {
          0% { transform: scale(1); opacity: .55 }
          70%, 100% { transform: scale(2.75); opacity: 0 }
        }
        .mp-beacon { animation: mp-beacon 2.6s cubic-bezier(.22,1,.36,1) infinite }
        @media (prefers-reduced-motion: reduce) {
          .mp-beacon { display: none }
        }
      `}</style>

      <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          The money path
        </span>
        <span className="hidden font-mono text-[10px] text-background-text sm:inline">
          two requests · one budget
        </span>
      </figcaption>

      <div ref={stageRef} className="relative">
        {/* request → decision */}
        <div data-mp-trace className="relative">
          <span
            aria-hidden
            className="-translate-x-1/2 absolute top-1 bottom-0 left-2 w-px bg-background-border"
          />

          <div data-mp-node="request" className="group relative pb-3 pl-8">
            <span
              aria-hidden
              data-mp-rail-dot
              className="-translate-x-1/2 absolute top-[5px] left-2 size-2.5 rounded-full bg-info ring-2 ring-info-bg"
            />
            <div className="flex items-baseline gap-2">
              <span className="whitespace-nowrap font-medium text-background-textContrast text-sm transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-info-text">
                Request
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-info-text">
                POST /v1/consume
              </span>
            </div>
            <p className="mt-0.5 text-background-text text-xs">
              the paid action asks before it runs
            </p>
          </div>

          <PhaseMarker>resolve</PhaseMarker>

          {resolveStations.map((station) => (
            <StationRow key={station.label} {...station} />
          ))}

          <PhaseMarker>decide</PhaseMarker>

          <div data-mp-node="decision" className="group relative mt-1 pl-8">
            <span
              aria-hidden
              data-mp-rail-dot
              className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-2 block size-2.5"
            >
              <span className="mp-beacon absolute inset-0 rounded-full bg-warning-text" />
              <span className="absolute inset-0 rounded-full bg-warning-text" />
            </span>
            <div className="relative rounded-sm border border-warning-line bg-warning-bgSubtle px-4 py-3 transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:border-warning-border group-data-[mp-hit=true]:bg-warning-bg">
              <span
                aria-hidden
                className="-top-px -left-px absolute size-2.5 border-warning-text border-t-2 border-l-2"
              />
              <span
                aria-hidden
                className="-top-px -right-px absolute size-2.5 border-warning-text border-t-2 border-r-2"
              />
              <span
                aria-hidden
                className="-bottom-px -left-px absolute size-2.5 border-warning-text border-b-2 border-l-2"
              />
              <span
                aria-hidden
                className="-bottom-px -right-px absolute size-2.5 border-warning-text border-r-2 border-b-2"
              />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-background-textContrast text-sm transition-colors duration-regular ease-out-quad">
                    Budget check
                  </p>
                  <p className="mt-0.5 text-background-text text-xs">
                    is this spend commercially allowed?
                  </p>
                </div>
                <div className="text-right">
                  <p
                    data-mp-budget
                    className={cn(
                      "font-medium font-mono text-lg leading-6 transition-colors duration-regular ease-out-quad",
                      budget.depleted ? "text-warning-text" : "text-background-textContrast"
                    )}
                  >
                    <AnimatedCounter value={budget.value} prefix="$" decimals={2} duration={650} />
                  </p>
                  <p className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                    remaining
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* fork connector (desktop) */}
        <div aria-hidden data-mp-connector className="relative hidden h-9 sm:block">
          <span className="-translate-x-1/2 absolute top-0 bottom-0 left-2 w-px bg-background-border" />
          <span className="absolute top-3 right-[calc(50%-20px)] bottom-0 left-2 rounded-tr-[10px] border-background-border border-t border-r border-dashed" />
        </div>

        {/* fork connector (stacked): keep the rail continuous so the fork
            reads as a consequence of the decision, not a new diagram */}
        <div aria-hidden className="relative h-7 sm:hidden">
          <span className="-translate-x-1/2 absolute top-0 bottom-0 left-2 w-0 border-background-border border-l border-dashed" />
        </div>

        {/* the two futures of the same request */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
          <div>
            <div
              data-mp-node="allow-chip"
              className="flex items-center gap-2.5 rounded-sm border border-success-border bg-success-bg px-3 py-2 transition-colors duration-regular ease-out-quad data-[mp-hit=true]:border-success-borderHover data-[mp-hit=true]:bg-success-bgActive"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-success-solid text-white">
                <Check aria-hidden className="size-3.5" />
              </span>
              <div className="flex flex-1 items-baseline justify-between gap-2">
                <p className="font-medium text-background-textContrast text-sm">
                  allow · within budget
                </p>
                <p className="font-mono text-[11px] text-success-text">200</p>
              </div>
            </div>
            <div className="relative mt-2">
              <span
                aria-hidden
                className="-top-2 -translate-x-1/2 absolute bottom-4 left-2 w-px bg-background-border"
              />
              {settleStations.map((station, index) => (
                <StationRow
                  key={station.label}
                  {...station}
                  variant={index === settleStations.length - 1 ? "terminal" : "default"}
                />
              ))}
            </div>
            {/* Terminal receipt rule (design-system-guidelines.md): the allow
                pass ends in a literal invoice line with its explain chain, not
                a sentence claiming one exists. */}
            <div className="mt-2 ml-8 rounded-sm border border-background-border bg-surface-raised px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                  invoice line · explain
                </span>
                <span className="font-medium font-mono text-[11px] text-background-textContrast">
                  $4.10
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
                pro@v3 · $0.002/token
              </p>
              <p className="font-mono text-[10px] text-background-text leading-4">
                reserve → capture · balanced
              </p>
            </div>
          </div>

          <div>
            <div
              data-mp-node="deny-chip"
              className="flex items-center gap-2.5 rounded-sm border border-danger-border bg-danger-bg px-3 py-2 transition-colors duration-regular ease-out-quad data-[mp-hit=true]:border-danger-borderHover data-[mp-hit=true]:bg-danger-bgActive"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-danger-solid text-white">
                <Ban aria-hidden className="size-3.5" />
              </span>
              <div className="flex flex-1 items-baseline justify-between gap-2">
                <p className="font-medium text-background-textContrast text-sm">
                  deny · over budget
                </p>
                <p className="font-mono text-[11px] text-danger-text">429</p>
              </div>
            </div>
            <div className="relative mt-2">
              <span
                aria-hidden
                className="-top-2 -translate-x-1/2 absolute bottom-4 left-2 w-0 border-background-border border-l border-dashed"
              />
              {ghostStations.map((station) => (
                <StationRow key={station.label} {...station} variant="ghost" />
              ))}
            </div>
            {/* The deny receipt is the same receipt, empty: absence as proof. */}
            <div className="mt-2 ml-8 rounded-sm border border-background-border border-dashed px-3 py-2 opacity-80">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                  invoice line
                </span>
                <span className="font-mono text-[11px] text-background-text">—</span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
                no cost created · nothing to explain
              </p>
            </div>
          </div>
        </div>

        {/* the request in flight — driven by the choreography effect above */}
        <span
          aria-hidden
          data-mp-dot
          className="pointer-events-none absolute top-0 left-0 size-[9px] rounded-full bg-info opacity-0 will-change-transform"
        />
      </div>

      <p className="mt-5 border-background-border border-t pt-3 text-background-text text-xs leading-6">
        Every step in this path is a method in the public SDK. Drop one call beside the logic you
        already run — TypeScript, REST, or curl.
      </p>
    </figure>
  )
}
