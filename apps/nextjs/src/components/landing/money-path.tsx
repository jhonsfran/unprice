"use client"

import { cn } from "@unprice/ui/utils"
import { Ban, Check } from "lucide-react"
import { useEffect, useRef } from "react"

// The signature visual: the money path, rendered as one request traced end to
// end. The brand works when the buyer can see the commercial decision and the
// evidence trail (docs/brand/brand-identity.md, design-system-guidelines.md):
// receipt-style stations with monospace facts, the budget decision framed by
// the bracket motif from the logo, and a literal fork — the allow branch
// settles and explains; the deny branch shows the same stations untouched, so
// "rejected before any cost" is visible as the absence of state. Token-driven;
// motion is the sanctioned request-path education: a dot walks the path in two
// alternating passes (deny first, then allow), lighting each station title it
// touches in the live-request `info` color. Removed under
// prefers-reduced-motion, started only when scrolled into view.

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
// pass 1 ends rejected at the deny chip (before any cost), pass 2 settles
// through wallet and ledger to the invoice. Highlights are driven from the
// same clock so titles light exactly when the dot reaches their station.
// ---------------------------------------------------------------------------

const DOT_SIZE = 7
const TRAVEL_SPEED = 0.5 // px per ms along the rail
const FADE_MS = 140
const STATION_DWELL = 140 // pause on each station ring
const DECISION_DWELL = 260
const HIT_LINGER = 380 // how long a title stays lit after the dot arrives
const OUTCOME_LINGER = 1100
const PASS_GAP = 600

type PassKind = "deny" | "allow"

type BuiltPass = {
  keyframes: Keyframe[]
  duration: number
  hits: { el: HTMLElement; at: number; until: number }[]
}

function buildPass(root: HTMLElement, kind: PassKind): BuiltPass | null {
  const rootBox = root.getBoundingClientRect()
  if (rootBox.width === 0) return null

  const node = (name: string) => root.querySelector<HTMLElement>(`[data-mp-node="${name}"]`)
  const trace = root.querySelector<HTMLElement>("[data-mp-trace]")
  const request = node("request")
  const decision = node("decision")
  if (!trace || !request || !decision) return null

  // Every station dot sits 8px inside its column (the `left-2` rail).
  const railXOf = (el: HTMLElement) => el.getBoundingClientRect().left - rootBox.left + 8
  const centerY = (el: HTMLElement) => {
    const b = el.getBoundingClientRect()
    return b.top - rootBox.top + b.height / 2
  }

  const railX = railXOf(trace)
  const pts: { x: number; y: number; o: number; t: number }[] = []
  const hits: BuiltPass["hits"] = []
  let t = 0

  const jump = (x: number, y: number, o: number, ms: number) => {
    t += ms
    pts.push({ x, y, o, t })
  }
  const move = (x: number, y: number) => {
    const p = pts[pts.length - 1]
    if (p) t += Math.hypot(x - p.x, y - p.y) / TRAVEL_SPEED
    pts.push({ x, y, o: 1, t })
  }
  const dwell = (ms: number) => {
    const p = pts[pts.length - 1]
    if (!p) return
    t += ms
    pts.push({ x: p.x, y: p.y, o: p.o, t })
  }
  const hit = (el: HTMLElement | null, linger = HIT_LINGER) => {
    if (el) hits.push({ el, at: t, until: t + linger })
  }

  // Entry: the dot is emitted from the request station.
  const requestY = request.getBoundingClientRect().top - rootBox.top + 10
  pts.push({ x: railX, y: requestY, o: 0, t: 0 })
  jump(railX, requestY, 1, FADE_MS)
  hit(request)
  dwell(STATION_DWELL)

  for (const name of ["plan-version", "pricing-rule", "meter", "entitlement"]) {
    const el = node(name)
    if (!el) continue
    move(railX, centerY(el))
    hit(el)
    dwell(STATION_DWELL)
  }

  move(railX, centerY(decision))
  hit(decision)
  dwell(DECISION_DWELL)

  if (kind === "deny") {
    const denyChip = node("deny-chip")
    if (!denyChip) return null
    const denyX = railXOf(denyChip)
    const denyY = centerY(denyChip)
    const connector = root.querySelector<HTMLElement>("[data-mp-connector]")
    const hasBranch = connector && getComputedStyle(connector).display !== "none"

    if (hasBranch) {
      // Follow the drawn dashed branch: down, across, into the chip.
      const branchY = connector.getBoundingClientRect().top - rootBox.top + 12
      move(railX, branchY)
      move(denyX, branchY)
      move(denyX, denyY)
    } else {
      // Stacked layout has no drawn branch — the dot hops to the outcome.
      const p = pts[pts.length - 1]
      if (p) jump(p.x, p.y, 0, FADE_MS)
      jump(denyX, denyY, 0, 40)
      jump(denyX, denyY, 1, FADE_MS)
    }
    hit(denyChip, OUTCOME_LINGER)
    dwell(320)
    jump(denyX, denyY, 0, FADE_MS)
  } else {
    const allowChip = node("allow-chip")
    if (!allowChip) return null
    move(railX, centerY(allowChip))
    hit(allowChip, HIT_LINGER + 200)
    dwell(STATION_DWELL)

    for (const name of ["wallet", "ledger"]) {
      const el = node(name)
      if (!el) continue
      move(railX, centerY(el))
      hit(el)
      dwell(STATION_DWELL)
    }

    const invoice = node("invoice")
    if (invoice) {
      move(railX, centerY(invoice))
      hit(invoice, OUTCOME_LINGER)
      dwell(320)
    }
    const p = pts[pts.length - 1]
    if (p) jump(p.x, p.y, 0, FADE_MS)
  }

  const duration = t
  if (duration <= 0) return null
  const half = DOT_SIZE / 2
  const keyframes = pts.map((p) => ({
    transform: `translate3d(${(p.x - half).toFixed(1)}px, ${(p.y - half).toFixed(1)}px, 0)`,
    opacity: p.o,
    offset: Math.min(1, p.t / duration),
  }))
  return { keyframes, duration, hits }
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
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-2 size-[9px] rounded-full",
          variant === "default" && "border border-background-borderHover bg-background-base",
          variant === "ghost" && "border border-background-borderHover border-dashed",
          variant === "terminal" && "bg-success-solid"
        )}
      />
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "whitespace-nowrap text-sm transition-colors duration-300",
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

function SdkName({ children }: { children: string }) {
  return (
    <code className="rounded-sm bg-background-bg px-1 py-px font-mono text-[11px] text-background-textContrast">
      {children}
    </code>
  )
}

export function MoneyPath({ className }: { className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null)

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
    let pass: PassKind = "deny"

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
    }
  }, [])

  return (
    <figure
      aria-label="The money path: one request traced end to end. A request resolves its plan version, pricing rule, meter, and entitlement, then reaches the budget decision. Within budget, the request is allowed with a 200: the wallet reserves credits, the ledger captures the movement, and the invoice line is explained by the same decision. Over budget, the request is denied with a 429 before any cost exists: the wallet is untouched, the ledger has no entry, and the invoice has no line."
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
          one request · both outcomes
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
              className="-translate-x-1/2 absolute top-[5px] left-2 size-2.5 rounded-full bg-info ring-2 ring-info-bg"
            />
            <div className="flex items-baseline gap-2">
              <span className="whitespace-nowrap font-medium text-background-textContrast text-sm transition-colors duration-300 group-data-[mp-hit=true]:text-info-text">
                Request
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-info-text">
                POST /v1/workflow
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
              className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-2 block size-2.5"
            >
              <span className="mp-beacon absolute inset-0 rounded-full bg-primary-text" />
              <span className="absolute inset-0 rounded-full bg-primary-text" />
            </span>
            <div className="relative rounded-sm border border-primary-line bg-primary-bgSubtle px-4 py-3">
              <span
                aria-hidden
                className="-top-px -left-px absolute size-2.5 border-primary-text border-t-2 border-l-2"
              />
              <span
                aria-hidden
                className="-top-px -right-px absolute size-2.5 border-primary-text border-t-2 border-r-2"
              />
              <span
                aria-hidden
                className="-bottom-px -left-px absolute size-2.5 border-primary-text border-b-2 border-l-2"
              />
              <span
                aria-hidden
                className="-bottom-px -right-px absolute size-2.5 border-primary-text border-r-2 border-b-2"
              />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-background-textContrast text-sm transition-colors duration-300 group-data-[mp-hit=true]:text-info-text">
                    Budget check
                  </p>
                  <p className="mt-0.5 text-background-text text-xs">
                    is this spend commercially allowed?
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium font-mono text-background-textContrast text-lg leading-6">
                    $4.10
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

        {/* the two futures of the same request */}
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-6 sm:mt-0 sm:grid-cols-2">
          <div>
            <div
              data-mp-node="allow-chip"
              className="flex items-center gap-2.5 rounded-sm border border-success-border bg-success-bg px-3 py-2 transition-colors duration-300 data-[mp-hit=true]:border-success-borderHover data-[mp-hit=true]:bg-success-bgActive"
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
            <p className="mt-1 pl-8 text-background-text text-xs leading-5">
              the invoice line is explained by the same decision that allowed it
            </p>
          </div>

          <div>
            <div
              data-mp-node="deny-chip"
              className="flex items-center gap-2.5 rounded-sm border border-danger-border bg-danger-bg px-3 py-2 transition-colors duration-300 data-[mp-hit=true]:border-danger-borderHover data-[mp-hit=true]:bg-danger-bgActive"
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
            <p className="mt-1 pl-8 text-background-text text-xs leading-5">
              denied in the request path — no cost was ever created
            </p>
          </div>
        </div>

        {/* the request in flight — driven by the choreography effect above */}
        <span
          aria-hidden
          data-mp-dot
          className="pointer-events-none absolute top-0 left-0 size-[7px] rounded-full bg-info opacity-0 will-change-transform"
        />
      </div>

      <p className="mt-5 border-background-border border-t pt-3 text-background-text text-xs leading-6">
        <SdkName>access.check</SdkName> is safe to run in shadow. <SdkName>usage.consume</SdkName>{" "}
        enforces in the request path. <SdkName>runs.*</SdkName> reserves budget before multi-step
        work. <SdkName>usage.record</SdkName> reports evidence without blocking.
      </p>
    </figure>
  )
}
