"use client"

import { cn } from "@unprice/ui/utils"
import { Ban, Check } from "lucide-react"
import { type RefObject, useEffect, useRef, useState } from "react"
import { AnimatedCounter } from "./animated-counter"
import { Leader } from "./station"

// The signature visual: the money path, rendered as one request traced end to
// end. The brand works when the buyer can see the commercial decision and the
// evidence trail (docs/brand/brand-identity.md, design-system-guidelines.md):
// receipt-style stations with monospace facts, the budget decision framed by
// the bracket motif from the logo, and a literal fork — the allow branch
// settles and explains; the deny branch shows the same stations untouched, so
// "rejected before any cost" is visible as the absence of state. The path
// ends at the buyer's own payment provider: funds settle in their Stripe
// account, never in Unprice's — the boundary the money never crosses is a
// station, not a footnote. Token-driven; motion is the sanctioned
// request-path education: a dot walks the path in three passes that share one
// budget — two identical requests are allowed and each wallet reservation
// visibly reduces the balance, so the third request arrives at a balance that
// cannot cover it and is denied. The outcome chips rest neutral and take
// their color only when the request reaches them, and the winning outcome
// stays lit until the next request spawns. Stacked (mobile) the fork
// collapses to one outcome column that follows the live request — the
// choreography stamps data-mp-outcome per pass and globals.css hides the
// other branch, so allow and deny swap in place instead of reading as
// "success first, denial later". Removed under prefers-reduced-motion (both
// branches stay visible), started only when scrolled into view.
//
// Two renders (2026-07-18): the hero carries variant="compact" — the gate
// only (request → price → budget check → the two decision chips), the same
// three-pass budget cycle, and a footer pointer to #money-path. The full
// trace with wallet, ledger, invoice receipt, and the payment terminus lives
// at station 04. First contact reads the decision moment in one glance; the
// accounting is one anchor away, not competing with the headline.

type Station = {
  id?: string
  label: string
  fact: string
}

// Narrative order, not dependency order: the event is measured first, then
// the access question, then what it costs — the same journey the request
// makes toward the budget decision. The plan version is not its own station:
// the pricing rule carries its pin (simplification round 2026-07-14), and the
// meter reading (2,050 tokens) is the quantity the invoice line multiplies
// out below, so the math is visible end to end: 2,050 × $0.002 = $4.10.
const resolveStations: Station[] = [
  { id: "meter", label: "Meter", fact: "tokens used · 2,050" },
  { id: "access", label: "Access", fact: "included in plan · yes" },
  { id: "pricing-rule", label: "Pricing rule", fact: "$0.002 / token · pro@v3" },
]

// The compact rail collapses the three resolve stations into the one fact the
// budget check consumes — the priced request. Meter, access, and the plan pin
// keep their own stations only in the full trace.
const gateStations: Station[] = [
  { id: "price", label: "Price", fact: "2,050 tokens × $0.002 = $4.10" },
]

const settleStations: Station[] = [
  { id: "wallet", label: "Wallet", fact: "reserve −$4.10" },
  { id: "ledger", label: "Ledger", fact: "capture · balanced" },
  { id: "invoice", label: "Invoice", fact: "line explained" },
]

// The terminus is the buyer's own provider account — the one distinction the
// diagram must carry: Unprice decides and explains, it never holds the funds.
const paymentStation: Station = { id: "payment", label: "Payment", fact: "your own Stripe" }

const ghostStations: Station[] = [
  { label: "Wallet", fact: "untouched" },
  { label: "Ledger", fact: "no entry" },
  { label: "Invoice", fact: "no line" },
]

// ---------------------------------------------------------------------------
// Request-path choreography. The dot walks measured waypoints along the rail
// through a three-pass cycle on one budget (management feedback 2026-07: the
// money story needs repetition to read) — $10.00 covers two $4.10 requests,
// so the arithmetic of the deny is visible: allow at $10.00, allow at $5.90,
// deny at $1.80. Highlights and the balance readout are driven from the same
// clock as the dot; the cycle restarts as a fresh billing period.
// ---------------------------------------------------------------------------

const REQUEST_COST = 4.1
const BUDGET_START = 10.0

type PassKind = "deny" | "allow"

type PassPlan = {
  kind: PassKind
  budgetStart: number
  budgetAfterReserve?: number
}

const PASS_PLAN: PassPlan[] = [
  { kind: "allow", budgetStart: BUDGET_START, budgetAfterReserve: BUDGET_START - REQUEST_COST },
  {
    kind: "allow",
    budgetStart: BUDGET_START - REQUEST_COST,
    budgetAfterReserve: BUDGET_START - 2 * REQUEST_COST,
  },
  { kind: "deny", budgetStart: BUDGET_START - 2 * REQUEST_COST },
]

// Deliberately slow (management feedback 2026-07: the previous tempo made the
// changes too small and too fast to follow) — the dot is narration, not an
// interaction echo, so the ambient-speed rule from the design guidelines
// applies and legibility beats snappiness.
const DOT_SIZE = 9
const TRAVEL_SPEED = 0.34 // px per ms along the rail
const FADE_MS = 200
const STATION_DWELL = 300 // pause on each station ring
const DECISION_DWELL = 650
const HIT_LINGER = 700 // how long a title stays lit after the dot arrives
const OUTCOME_LINGER = 1600
const PASS_GAP = 1100
const CYCLE_GAP = 1800 // extra beat before the budget refills for a new period
const RAIL_OFFSET_X = 8
const CHIP_CLEARANCE_Y = 6
// Outcome chips keep their color until the next request spawns, so the story
// so far stays readable between passes.
const PERSIST = Number.POSITIVE_INFINITY

type BuiltPass = {
  keyframes: Keyframe[]
  duration: number
  hits: { el: HTMLElement; at: number; until: number }[]
  // Budget updates on the same clock: the wallet reservation counts the
  // remaining balance down mid-pass; a new cycle refills it.
  sets: { at: number; value: number }[]
}

function buildPass(root: HTMLElement, plan: PassPlan, stations: Station[]): BuiltPass | null {
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
  const setBudget = (value: number) => {
    sets.push({ at: t, value })
  }

  // The pass spawns with the balance the story left it: a new cycle refills
  // it (a fresh billing period), a deny pass inherits a balance the request
  // cost no longer fits — that is why it is denied.
  setBudget(plan.budgetStart)

  // Entry: the dot is emitted from the request station.
  pts.push({ x: requestPoint.x, y: requestPoint.y, o: 0, t: 0, s: requestPoint.size })
  jump(requestPoint.x, requestPoint.y, 1, FADE_MS, requestPoint.size)
  hit(request)
  dwell(STATION_DWELL)

  for (const station of stations) {
    const el = station.id ? node(station.id) : null
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

  if (plan.kind === "deny") {
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
    } else {
      // Stacked: the outcome column sits directly under the decision, so the
      // deny walks the rail down to its chip the same way the allow does.
      move(railX, denyTop - CHIP_CLEARANCE_Y)
    }
    // The dot never enters the chip; its highlight takes over and persists.
    fadeOut()
    hit(denyChip, PERSIST)
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
    hit(allowChip, PERSIST)
    // The compact rail has no wallet station, so the reservation lands where
    // the story ends there: the balance drops the moment the allow lights.
    if (plan.budgetAfterReserve !== undefined && !node("wallet")) {
      setBudget(plan.budgetAfterReserve)
    }
    dwell(STATION_DWELL)

    for (const [index, name] of ["wallet", "ledger", "invoice"].entries()) {
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
      // The reservation is the moment the money moves: the balance drops as
      // the wallet reserves, in plain sight.
      if (name === "wallet" && plan.budgetAfterReserve !== undefined) {
        setBudget(plan.budgetAfterReserve)
      }
      dwell(STATION_DWELL)
    }

    // The terminus: the money lands in the buyer's own provider account —
    // the dot travels past the invoice receipt to where the funds settle.
    const payment = node("payment")
    if (payment) {
      const point = railPointOf(payment)
      move(point.x, point.y, point.size)
      hit(payment, OUTCOME_LINGER)
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

function StationRow({
  id,
  label,
  fact,
  note,
  variant = "default",
}: Station & { note?: string; variant?: "default" | "ghost" | "terminal" }) {
  return (
    <div
      data-mp-node={id}
      className={cn("group relative py-[5px] pl-8", variant === "ghost" && "opacity-80")}
    >
      {/* The dot lives inside the title line so rows with a note keep it
          centered against the label, not the taller block. */}
      <div className="relative flex items-baseline gap-2">
        <span
          aria-hidden
          data-mp-rail-dot
          className={cn(
            "-translate-x-1/2 -translate-y-1/2 -left-6 absolute top-1/2 size-[9px] rounded-full",
            variant === "default" && "border border-background-borderHover bg-surface-panel",
            variant === "ghost" && "border border-background-borderHover border-dashed",
            // The settled green is earned, not ambient: neutral until the
            // request actually reaches the line.
            variant === "terminal" &&
              "border border-background-borderHover bg-surface-panel transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:border-success-solid group-data-[mp-hit=true]:bg-success-solid"
          )}
        />
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
            "whitespace-nowrap font-mono text-[11px] text-background-text",
            variant === "terminal" &&
              "transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-success-text"
          )}
        >
          {fact}
        </span>
      </div>
      {note ? <p className="mt-0.5 text-background-text text-xs">{note}</p> : null}
    </div>
  )
}

type Budget = { value: number; short: boolean }

type Choreography = {
  budget: Budget
  /** 1-based number of the request currently walking the path; null until
   * the choreography starts (and under reduced motion). */
  passNumber: number | null
}

// The request-path choreography: watches the stage into view, then animates
// the dot through the three-pass cycle and drives the balance readout and the
// pass counter off the same clock. Lifted out of the component so MoneyPath
// stays render-only.
function useMoneyPathChoreography(
  stageRef: RefObject<HTMLDivElement | null>,
  stations: Station[]
): Choreography {
  const [budget, setBudget] = useState<Budget>({ value: BUDGET_START, short: false })
  const [passNumber, setPassNumber] = useState<number | null>(null)

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
    let passIndex = 0

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
          if (s) setBudget({ value: s.value, short: s.value < REQUEST_COST })
          setIndex += 1
        }
      }
      raf = requestAnimationFrame(tick)
    }

    const runPass = () => {
      if (cancelled) return
      anim?.cancel()
      clearHits()
      const plan = PASS_PLAN[passIndex % PASS_PLAN.length]
      if (!plan) return
      // Stacked layouts render only the live pass's outcome branch — stamp it
      // synchronously so buildPass measures the final layout.
      root.setAttribute("data-mp-outcome", plan.kind)
      setPassNumber((passIndex % PASS_PLAN.length) + 1)
      passIndex += 1
      const built = buildPass(root, plan, stations)
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
          if (cancelled) return
          // A finished deny closes the cycle: hold the beat a little longer
          // before the budget refills as a new billing period.
          const gap = passIndex % PASS_PLAN.length === 0 ? CYCLE_GAP : PASS_GAP
          timer = setTimeout(runPass, gap)
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
      root.removeAttribute("data-mp-outcome")
      setBudget({ value: BUDGET_START, short: false })
      setPassNumber(null)
    }
  }, [stageRef, stations])

  return { budget, passNumber }
}

// request → decision: one uninterrupted rail — the checks and the budget gate
// read as one section. The balance is the one oversized fact on the rail, so
// the money moving stays the most legible change on screen without the gate
// outshouting the outcomes. Compact drops the request caption (the hero
// subhead directly beside it says the same thing) and keeps the decision
// caption, which carries the arithmetic.
function RequestDecisionRail({
  budget,
  stations,
  compact = false,
}: {
  budget: Budget
  stations: Station[]
  compact?: boolean
}) {
  return (
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
        {compact ? null : (
          <p className="mt-0.5 text-background-text text-xs">the paid action asks before it runs</p>
        )}
      </div>

      {stations.map((station) => (
        <StationRow key={station.label} {...station} />
      ))}

      {/* The decision is a station like the others (simplification round
          2026-07-14: the framed box outshouted the outcomes) — what stays
          special is small: the beacon dot, the bracket ticks around the
          balance (the logo echo at the exact deciding fact), and the number
          itself, sized to be watched counting down. */}
      <div data-mp-node="decision" className="group relative mt-1 py-[5px] pl-8">
        {/* The beacon lives inside the title line and centers against it —
            the bracketed balance makes this line taller than a plain row, so
            a block-level offset drifts off the title (user-reported). */}
        <div className="relative flex items-center gap-2">
          <span
            aria-hidden
            data-mp-rail-dot
            className="-translate-x-1/2 -translate-y-1/2 -left-6 absolute top-1/2 block size-2.5"
          >
            <span className="mp-beacon absolute inset-0 rounded-full bg-warning-text" />
            <span className="absolute inset-0 rounded-full bg-warning-text" />
          </span>
          <span className="whitespace-nowrap font-medium text-background-textContrast text-sm transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-info-text">
            Budget check
          </span>
          <Leader />
          <span className="relative whitespace-nowrap px-2 py-0.5">
            <span
              aria-hidden
              className="absolute top-0 left-0 size-1.5 border-warning-text border-t border-l"
            />
            <span
              aria-hidden
              className="absolute top-0 right-0 size-1.5 border-warning-text border-t border-r"
            />
            <span
              aria-hidden
              className="absolute bottom-0 left-0 size-1.5 border-warning-text border-b border-l"
            />
            <span
              aria-hidden
              className="absolute right-0 bottom-0 size-1.5 border-warning-text border-r border-b"
            />
            <span
              data-mp-budget
              className={cn(
                "font-medium font-mono text-lg leading-6 transition-colors duration-regular ease-out-quad",
                budget.short ? "text-warning-text" : "text-background-textContrast"
              )}
            >
              <AnimatedCounter value={budget.value} prefix="$" decimals={2} duration={650} />
            </span>
          </span>
        </div>
        <p className="mt-0.5 text-background-text text-xs">
          does the balance cover this $4.10 request?
        </p>
      </div>
    </div>
  )
}

// One future of the request, as a chip that rests neutral — the color is the
// decision happening, so it arrives only when the request does (management
// feedback 2026-07), and the winning outcome stays lit until the next request
// spawns. Shared by the full fork and the compact gate so both renders speak
// one grammar: outcome, status code, and the arithmetic that decided it.
function OutcomeChip({ kind }: { kind: "allow" | "deny" }) {
  const allow = kind === "allow"
  return (
    <div
      data-mp-node={allow ? "allow-chip" : "deny-chip"}
      className={cn(
        "group flex items-center gap-2.5 rounded-sm border border-background-border bg-surface-raised px-3 py-2 transition-colors duration-regular ease-out-quad",
        allow
          ? "data-[mp-hit=true]:border-success-border data-[mp-hit=true]:bg-success-bg"
          : "data-[mp-hit=true]:border-danger-border data-[mp-hit=true]:bg-danger-bg"
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm bg-background-bgActive text-background-text transition-colors duration-regular ease-out-quad group-data-[mp-hit=true]:text-white",
          allow
            ? "group-data-[mp-hit=true]:bg-success-solid"
            : "group-data-[mp-hit=true]:bg-danger-solid"
        )}
      >
        {allow ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <Ban aria-hidden className="size-3.5" />
        )}
      </span>
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-background-textContrast text-sm">
            {allow ? "allow · within budget" : "deny · over budget"}
          </p>
          <p
            className={cn(
              "font-mono text-[11px] text-background-text transition-colors duration-regular ease-out-quad",
              allow
                ? "group-data-[mp-hit=true]:text-success-text"
                : "group-data-[mp-hit=true]:text-danger-text"
            )}
          >
            {allow ? "200" : "429"}
          </p>
        </div>
        {/* The deny arithmetic is the punchline of the whole demo: the third
            request needs more than the balance the first two left. */}
        <p className="font-mono text-[10px] text-background-text leading-4">
          {allow ? "cost $4.10 · covered by balance" : "needs $4.10 · balance $1.80"}
        </p>
      </div>
    </div>
  )
}

// The two futures of the same request, with their consequences. The deny
// branch shows the same stations untouched — absence as proof. The
// data-mp-branch attributes drive the stacked-layout morph (globals.css): on
// mobile only the live pass's branch is shown.
function OutcomeFork() {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
      <div data-mp-branch="allow">
        <OutcomeChip kind="allow" />
        <div className="relative mt-2">
          <span
            aria-hidden
            className="-top-2 -translate-x-1/2 absolute bottom-8 left-2 w-px bg-background-border"
          />
          {settleStations.map((station) => (
            <StationRow key={station.label} {...station} />
          ))}
          {/* Terminal receipt rule (design-system-guidelines.md): the allow
              pass ends in a literal invoice line with its explain chain, not
              a sentence claiming one exists. */}
          <div className="my-1 ml-8 rounded-sm border border-background-border bg-surface-raised px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                invoice line · explain
              </span>
              <span className="font-medium font-mono text-[11px] text-background-textContrast">
                $4.10
              </span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
              2,050 tokens × $0.002 · pro@v3
            </p>
            <p className="font-mono text-[10px] text-background-text leading-4">
              reserve → capture · balanced
            </p>
          </div>
          {/* The path ends in the buyer's account, not ours — the funds
              boundary stated as a station. */}
          <StationRow
            {...paymentStation}
            variant="terminal"
            note="the money never touches Unprice"
          />
        </div>
      </div>

      <div data-mp-branch="deny">
        <OutcomeChip kind="deny" />
        <div className="relative mt-2">
          <span
            aria-hidden
            className="-top-2 -translate-x-1/2 absolute bottom-4 left-2 w-0 border-background-border border-l border-dashed"
          />
          {ghostStations.map((station) => (
            <StationRow key={station.label} {...station} variant="ghost" />
          ))}
          {/* The deny receipt is the same receipt, empty: absence as proof —
              plus the one thing a deny does return: its reason, to your app. */}
          <div className="my-1 ml-8 rounded-sm border border-background-border border-dashed px-3 py-2 opacity-80">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
                invoice line
              </span>
              <span className="font-mono text-[11px] text-background-text">—</span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-background-text leading-4">
              no cost created · nothing to explain
            </p>
            {/* Same arrow grammar as the allow receipt's "reserve → capture":
                the one thing a deny does produce is its reason, delivered to
                the builder's app. */}
            <p className="font-mono text-[10px] text-background-text leading-4">
              reason → your app · limit exceeded
            </p>
          </div>
          <StationRow label="Payment" fact="no charge" variant="ghost" />
        </div>
      </div>
    </div>
  )
}

const FULL_ARIA =
  "The money path: three identical requests traced against one $10.00 budget. Each request hits the meter — 2,050 tokens — passes the access check, resolves its price — $0.002 per token on plan version pro@v3 — then reaches the budget check, which asks whether the balance covers the $4.10 this request costs. The first request is allowed with a 200: the wallet reserves $4.10, the ledger captures the movement, the invoice line — 2,050 tokens at $0.002, $4.10 — is explained by the same decision, and payment settles in your own Stripe account, leaving $5.90. Unprice never holds the funds. The second identical request is allowed the same way, leaving $1.80. The third request needs $4.10 but the balance is $1.80, so it is denied with a 429 before any cost exists: the wallet is untouched, the ledger has no entry, the invoice has no line, nothing is charged — and the deny reason is returned to your app."

const COMPACT_ARIA =
  "The money path, abridged to the decision moment: three identical requests against one $10.00 budget. Each request is priced — 2,050 tokens at $0.002, $4.10 — then the budget check asks whether the balance covers it. The first two requests are allowed with a 200, at $10.00 and $5.90, each reserving $4.10. The third arrives at $1.80, cannot cover $4.10, and is denied with a 429 before any cost exists. The full path — wallet, ledger, invoice, and payment settling to your own Stripe — is traced further down the page."

export function MoneyPath({
  className,
  variant = "full",
}: {
  className?: string
  /** "compact" is the hero render: the gate only — request, price, budget
   * check, and the two decision chips — with a pointer to the full trace. */
  variant?: "full" | "compact"
}) {
  const compact = variant === "compact"
  const stations = compact ? gateStations : resolveStations
  const stageRef = useRef<HTMLDivElement>(null)
  const { budget, passNumber } = useMoneyPathChoreography(stageRef, stations)

  return (
    <figure
      aria-label={compact ? COMPACT_ARIA : FULL_ARIA}
      className={cn("mx-auto w-full", compact ? "max-w-xl" : "max-w-3xl", className)}
    >
      <figcaption className="mb-4 flex items-baseline justify-between gap-4 border-background-border border-b pb-3">
        <span className="font-mono text-background-text text-xs uppercase tracking-widest">
          The money path
        </span>
        <span className="font-mono text-[10px] text-background-text">
          {passNumber === null ? "three requests · one budget" : `request ${passNumber} of 3`}
        </span>
      </figcaption>

      <div ref={stageRef} className="relative">
        {/* request → decision */}
        <RequestDecisionRail budget={budget} stations={stations} compact={compact} />

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

        {/* the two futures of the same request — the compact gate ends here;
            the full render carries each future to its consequences */}
        {compact ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div data-mp-branch="allow">
              <OutcomeChip kind="allow" />
            </div>
            <div data-mp-branch="deny">
              <OutcomeChip kind="deny" />
            </div>
          </div>
        ) : (
          <OutcomeFork />
        )}

        {/* the request in flight — driven by the choreography effect above */}
        <span
          aria-hidden
          data-mp-dot
          className="pointer-events-none absolute top-0 left-0 size-[9px] rounded-full bg-info opacity-0 will-change-transform"
        />
      </div>

      {compact ? (
        // The abridged render hands off to the full receipt instead of
        // carrying it: the terminal-moment rule is satisfied one anchor away.
        <a
          href="#money-path"
          className="group mt-5 flex items-baseline justify-between gap-4 border-background-border border-t pt-3"
        >
          <span className="text-background-text text-xs leading-6">
            Allow settles. Deny costs nothing.
          </span>
          <span className="whitespace-nowrap font-mono text-[11px] text-background-text transition-colors duration-regular ease-out-quad group-hover:text-background-textContrast">
            follow the full path ↓
          </span>
        </a>
      ) : (
        <p className="mt-5 border-background-border border-t pt-3 text-background-text text-xs leading-6">
          Every step in this path is a method in the public SDK. Run the check in shadow beside the
          logic you already run — TypeScript, REST, or curl.
        </p>
      )}
    </figure>
  )
}
