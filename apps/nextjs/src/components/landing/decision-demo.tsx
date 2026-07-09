"use client"

import { cn, focusRing } from "@unprice/ui/utils"
import { ArrowRight, Ban, Check, Flag, MousePointerClick, RotateCcw } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { AnimatedCounter } from "./animated-counter"
import { Reveal } from "./reveal"
import { Leader, LedgerRow, SectionShell, StationDot } from "./station"
import { StationHeader } from "./station-header"

// Station 03: the money path, driven by hand. The hero animates one request
// end to end; here the reader fires the request themselves. Left panel is the
// customer's plan sheet (each paid action a clickable ledger row), the right
// panel is the decision receipt the runtime returns — the same allow/deny
// chips, evidence rows, and ghost-absence grammar the money path uses. One
// info dot carries each click across the labeled request/decision boundary.
// Every fact rendered is real demo state; the deny branch proves itself by
// what it does NOT create.

// ============================================
// PLAN MODEL
// ============================================

type FeatureType = "usage" | "flat" | "tiered"

interface Tier {
  upto: number | "unlimited"
  rate: number
}

interface FeatureConfig {
  limitType: "hard" | "soft"
  limit: number
}

interface Feature {
  id: string
  displayName: string
  type: FeatureType
  /** The SDK method this paid action calls — the demo's API voice. */
  call: string
  rate: number
  tiers?: Tier[]
  unit: string
  rateUnit: string
  usage: number
  config: FeatureConfig
}

const DEMO_CUSTOMER = "acme-corp"
const DEMO_PLAN_VERSION = "pro@v3"
const BASE_FEE = 19

// Limits are demo-scale on purpose: the deny is reachable in a handful of
// clicks, the soft warning in four, and storage crosses a pricing tier on the
// way — the guardrails are the story, not the ceiling.
const DEFAULT_FEATURES: Feature[] = [
  {
    id: "api_request",
    displayName: "API requests",
    type: "usage",
    call: "usage.consume",
    rate: 0.1,
    unit: "requests",
    rateUnit: "request",
    usage: 0,
    config: { limitType: "hard", limit: 5 },
  },
  {
    id: "storage_gb",
    displayName: "Storage",
    type: "tiered",
    call: "usage.consume",
    rate: 0.5,
    tiers: [
      { upto: 2, rate: 0 },
      { upto: 5, rate: 0.5 },
      { upto: "unlimited", rate: 0.8 },
    ],
    unit: "GB",
    rateUnit: "GB",
    usage: 0,
    config: { limitType: "hard", limit: 6 },
  },
  {
    id: "compute_min",
    displayName: "Compute",
    type: "usage",
    call: "runs.start",
    rate: 0.15,
    unit: "GB-hrs",
    rateUnit: "GB-hr",
    usage: 0,
    config: { limitType: "soft", limit: 3 },
  },
  {
    id: "premium_support",
    displayName: "Premium support",
    type: "flat",
    call: "access.check",
    rate: 5,
    unit: "seat",
    rateUnit: "seat",
    usage: 0,
    config: { limitType: "soft", limit: 1 },
  },
]

function tierFor(feature: Feature, usage: number): { index: number; rate: number } {
  if (!feature.tiers) return { index: 1, rate: feature.rate }
  let lastUpto = 0
  for (const [i, tier] of feature.tiers.entries()) {
    const upto = tier.upto === "unlimited" ? Number.POSITIVE_INFINITY : tier.upto
    if (usage > lastUpto && usage <= upto) return { index: i + 1, rate: tier.rate }
    lastUpto = upto
  }
  return { index: feature.tiers.length, rate: feature.rate }
}

function featureCost(feature: Feature): number {
  if (feature.type === "usage") return feature.usage * feature.rate
  if (feature.type === "flat") return feature.usage > 0 ? feature.rate : 0
  let cost = 0
  let remaining = feature.usage
  let lastUpto = 0
  for (const tier of feature.tiers ?? []) {
    const upto = tier.upto === "unlimited" ? Number.POSITIVE_INFINITY : tier.upto
    const inTier = Math.max(0, Math.min(remaining, upto - lastUpto))
    cost += inTier * tier.rate
    remaining -= inTier
    lastUpto = upto
    if (remaining <= 0) break
  }
  return cost
}

/** What this single click would cost — tier-aware, so the storage rows narrate
 * the tier ladder ($0.00 → $0.50 → $0.80) one decision at a time. */
function marginalCharge(feature: Feature, nextUsage: number): number {
  if (feature.type === "flat") return feature.usage === 0 ? feature.rate : 0
  if (feature.type === "tiered") return tierFor(feature, nextUsage).rate
  return feature.rate
}

function pricingRuleLabel(feature: Feature): string {
  if (feature.type === "flat") return `$${feature.rate.toFixed(2)} flat`
  if (feature.type === "tiered") {
    const tier = tierFor(feature, Math.max(1, feature.usage))
    return tier.rate === 0
      ? `tier ${tier.index} · free`
      : `tier ${tier.index} · $${tier.rate.toFixed(2)} / ${feature.rateUnit}`
  }
  return `$${feature.rate.toFixed(2)} / ${feature.rateUnit}`
}

function guardrailLabel(feature: Feature): string {
  if (feature.type === "flat") return `included · ${feature.config.limit} ${feature.unit}`
  return `${feature.config.limitType} · ${feature.config.limit} ${feature.unit}`
}

/** Derived, never stored: a row is blocked when its next request would cross a
 * hard guardrail, flagged when it already crossed a soft one. Editing the rule
 * re-derives both — raising a limit unblocks the row with no bookkeeping. */
function rowStatus(feature: Feature): "blocked" | "flagged" | "open" {
  if (feature.type === "flat") return "open"
  if (feature.config.limitType === "hard" && feature.usage + 1 > feature.config.limit) {
    return "blocked"
  }
  if (feature.config.limitType === "soft" && feature.usage > feature.config.limit) {
    return "flagged"
  }
  return "open"
}

// ============================================
// DECISION MODEL — what the runtime answered
// ============================================

type DecisionKind = "allow" | "warn" | "deny"

interface Decision {
  kind: DecisionKind
  featureId: string
  charge: number
  reason: string
  seq: number
}

const DECISION_COPY: Record<
  DecisionKind,
  { title: string; code: string; next: string; value: string }
> = {
  allow: {
    title: "allow · within plan",
    code: "200",
    next: "run the work · keep the evidence",
    value: "allow",
  },
  warn: {
    title: "allow · soft limit crossed",
    code: "200",
    next: "run the work · flag the account",
    value: "allow",
  },
  deny: {
    title: "deny · before any cost",
    code: "429",
    next: "do not run · no cost created",
    value: "deny",
  },
}

// ============================================
// SHARED RECEIPT PIECES
// ============================================

function ReceiptMarker({ children }: { children: string }) {
  return (
    <div aria-hidden className="flex items-center gap-2 pt-3 pb-1">
      <span className="h-px w-3 shrink-0 bg-background-border" />
      <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
        {children}
      </span>
    </div>
  )
}

function PanelFrame({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-lg border border-background-border bg-surface-panel",
        className
      )}
    >
      {children}
    </div>
  )
}

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

// ============================================
// PLAN PANEL — the paid actions, as a ledger
// ============================================

interface PlanRowProps {
  feature: Feature
  isHit: boolean
  onFire: (id: string) => void
}

// The plan ships with both guardrail types in the rows themselves (API
// requests and storage are hard, compute is soft) — no config UI, the
// examples are the lesson. A blocked row stays clickable on purpose: every
// further click still sends a real request and gets the deny receipt back,
// so rejection is a state the reader can keep inspecting, not a dead button.
function PlanRow({ feature, isHit, onFire }: PlanRowProps) {
  const status = rowStatus(feature)
  const isFlat = feature.type === "flat"
  const progress = isFlat ? 0 : Math.min(100, (feature.usage / feature.config.limit) * 100)

  const usageFact = isFlat ? (
    feature.usage > 0 ? (
      "active · 1 seat"
    ) : (
      "inactive"
    )
  ) : (
    <>
      <AnimatedCounter value={feature.usage} /> / {feature.config.limit} {feature.unit}
      {status === "blocked" && " · blocked"}
      {status === "flagged" && " · flagged"}
    </>
  )

  return (
    <button
      type="button"
      onClick={() => onFire(feature.id)}
      aria-label={`Send one ${feature.displayName} request · ${pricingRuleLabel(feature)}`}
      className={cn(
        // Full-bleed list row: the hover wash and hairline rules run edge to
        // edge of the panel, like a table row — never a floating gray box.
        "block w-full border-background-line border-b px-4 py-2.5 text-left transition-colors duration-quick ease-out-quad last:border-0 hover:bg-background-bgHover active:bg-background-bgActive sm:px-5",
        focusRing
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden
          className={cn(
            "size-[9px] shrink-0 self-center rounded-full transition-colors duration-quick ease-out-quad",
            isHit
              ? "bg-info ring-2 ring-info-bg"
              : status === "blocked"
                ? "bg-danger-solid"
                : status === "flagged"
                  ? "bg-warning-solid"
                  : "border border-background-borderHover bg-surface-panel"
          )}
        />
        <span
          className={cn(
            "whitespace-nowrap font-medium text-sm transition-colors duration-quick ease-out-quad",
            isHit ? "text-info-text" : "text-background-textContrast"
          )}
        >
          {feature.displayName}
        </span>
        <Leader />
        <span
          className={cn(
            "whitespace-nowrap font-mono text-[11px] tabular-nums",
            status === "blocked"
              ? "text-danger-text"
              : status === "flagged"
                ? "text-warning-text"
                : "text-background-text"
          )}
        >
          {usageFact}
        </span>
      </div>
      <div className="mt-0.5 truncate pl-[17px] font-mono text-[10px] text-background-text">
        {feature.call} · {pricingRuleLabel(feature)}
        {!isFlat && ` · ${feature.config.limitType}`}
      </div>
      {!isFlat && (
        <div className="mt-1.5 ml-[17px] h-0.5 overflow-hidden rounded-full bg-background-line">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-regular ease-out-quad",
              progress >= 100
                ? feature.config.limitType === "hard"
                  ? "bg-danger-solid"
                  : "bg-warning-solid"
                : progress >= 80
                  ? "bg-warning-solid"
                  : "bg-background-borderHover"
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </button>
  )
}

// ============================================
// DECISION RECEIPT — the runtime's answer
// ============================================

interface DecisionReceiptProps {
  decision: Decision | null
  feature: Feature | null
  chipHit: boolean
}

function OutcomeChip({ decision, chipHit }: { decision: Decision | null; chipHit: boolean }) {
  if (!decision) {
    return (
      <div className="flex items-center gap-2.5 rounded-sm border border-background-border border-dashed px-3 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-background-borderHover border-dashed text-background-text">
          <MousePointerClick aria-hidden className="size-3.5" />
        </span>
        <div className="flex flex-1 items-baseline justify-between gap-2">
          <p className="font-medium text-background-text text-sm">awaiting the first request</p>
          <p className="font-mono text-[11px] text-background-text">—</p>
        </div>
      </div>
    )
  }

  const copy = DECISION_COPY[decision.kind]
  const Icon = decision.kind === "deny" ? Ban : decision.kind === "warn" ? Flag : Check

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-sm border px-3 py-2 transition-colors duration-regular ease-out-quad",
        decision.kind === "deny" &&
          (chipHit
            ? "border-danger-borderHover bg-danger-bgActive"
            : "border-danger-border bg-danger-bg"),
        decision.kind === "warn" &&
          (chipHit
            ? "border-warning-borderHover bg-warning-bgActive"
            : "border-warning-border bg-warning-bg"),
        decision.kind === "allow" &&
          (chipHit
            ? "border-success-borderHover bg-success-bgActive"
            : "border-success-border bg-success-bg")
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm",
          decision.kind === "deny"
            ? "bg-danger-solid text-danger-foreground"
            : decision.kind === "warn"
              ? "bg-warning-solid text-warning-foreground"
              : "bg-success-solid text-success-foreground"
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>
      <div className="flex flex-1 items-baseline justify-between gap-2">
        <p className="font-medium text-background-textContrast text-sm">{copy.title}</p>
        <p
          className={cn(
            "font-mono text-[11px]",
            decision.kind === "deny"
              ? "text-danger-text"
              : decision.kind === "warn"
                ? "text-warning-text"
                : "text-success-text"
          )}
        >
          {copy.code}
        </p>
      </div>
    </div>
  )
}

function DecisionReceipt({ decision, feature, chipHit }: DecisionReceiptProps) {
  const pending = !decision || !feature
  const denied = decision?.kind === "deny"
  const covered = decision?.reason === "already_included"
  const remaining = feature ? Math.max(0, feature.config.limit - feature.usage) : 0

  // Evidence facts derive from live plan state, not a snapshot: raising a
  // blocked row's limit updates "remaining" on the receipt in place — the fix
  // is visible before the retry.
  const evidence = pending
    ? [
        { label: "call", fact: "—" },
        { label: "plan version", fact: "—" },
        { label: "pricing rule", fact: "—" },
        { label: "guardrail", fact: "—" },
        { label: "remaining", fact: "—" },
      ]
    : [
        {
          label: "call",
          fact: feature.call,
          factClassName: "text-info-text",
        },
        { label: "plan version", fact: DEMO_PLAN_VERSION },
        { label: "pricing rule", fact: pricingRuleLabel(feature) },
        { label: "guardrail", fact: guardrailLabel(feature) },
        {
          label: "remaining",
          fact:
            feature.type === "flat" ? (
              "included"
            ) : (
              <>
                <AnimatedCounter value={remaining} /> {feature.unit}
              </>
            ),
          factClassName: denied ? "text-danger-text" : "text-background-textContrast",
        },
      ]

  // The same four receipt lines on every outcome. The deny proves itself by
  // absence — never ran, no entry, no line — exactly like the money path's
  // untouched ghost stations; the allow fills the same lines in.
  const created: { label: string; fact: ReactNode; ghost: boolean }[] =
    pending || denied
      ? [
          { label: "work", fact: pending ? "—" : "never ran", ghost: true },
          { label: "accepted charge", fact: pending ? "—" : "none", ghost: true },
          { label: "ledger", fact: pending ? "—" : "no entry", ghost: true },
          { label: "invoice line", fact: pending ? "—" : "no line", ghost: true },
        ]
      : [
          { label: "work", fact: "executed", ghost: false },
          {
            label: "accepted charge",
            fact: <AnimatedCounter value={decision.charge} prefix="$" decimals={2} />,
            ghost: false,
          },
          {
            label: "ledger",
            fact: covered ? "no new entry" : "capture · balanced",
            ghost: covered,
          },
          {
            label: "invoice line",
            fact: covered ? "no new line" : "explained · evidence attached",
            ghost: covered,
          },
        ]

  return (
    <div className="flex flex-1 flex-col">
      <div aria-live="polite">
        <OutcomeChip decision={decision} chipHit={chipHit} />
      </div>

      <ReceiptMarker>evidence kept with the decision</ReceiptMarker>
      <div className="flex flex-col">
        {evidence.map((row) => (
          <LedgerRow
            key={row.label}
            label={row.label}
            fact={row.fact}
            variant="ghost"
            labelClassName="text-xs"
            factClassName={"factClassName" in row ? row.factClassName : undefined}
          />
        ))}
      </div>

      <ReceiptMarker>what this click created</ReceiptMarker>
      <div className="flex flex-col">
        {created.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 py-[5px]">
            <StationDot variant={row.ghost ? "ghost" : "default"} className="self-center" />
            <span className="text-background-text text-xs">{row.label}</span>
            <Leader />
            <span
              className={cn(
                "whitespace-nowrap text-right font-mono text-[11px]",
                row.ghost ? "text-background-text" : "text-background-textContrast"
              )}
            >
              {row.fact}
            </span>
          </div>
        ))}
      </div>

      {/* The API voice, as the terminal receipt artifact. It teaches even
          while idle — the pending state is a real state, not a placeholder. */}
      <div className="mt-auto pt-4">
        <div className="rounded-sm border border-background-border bg-surface-raised px-3 py-2 font-mono text-[11px] text-background-text leading-5">
          <span className="text-background-textContrast">decision</span>
          {` = ${pending ? "pending" : DECISION_COPY[decision.kind].value}`}
          <br />
          <span className="text-background-textContrast">reason</span>
          {` = ${pending ? "no_request_sent" : decision.reason}`}
          <br />
          <span className="text-background-textContrast">next</span>
          {` = ${pending ? "click a paid action on the plan" : DECISION_COPY[decision.kind].next}`}
        </div>
      </div>
    </div>
  )
}

// ============================================
// INVOICE RECEIPT — the same path, at month end
// ============================================

function InvoiceReceipt({ features }: { features: Feature[] }) {
  const metered = features.reduce((sum, f) => sum + featureCost(f), 0)
  const total = BASE_FEE + metered

  const period = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })

  const qtyLabel = (f: Feature) => {
    if (f.type === "flat") return "1 seat · flat"
    if (f.type === "tiered") return `${f.usage} ${f.unit} · tiered`
    return `${f.usage} × $${f.rate.toFixed(2)}`
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col">
        <LedgerRow
          label="invoice"
          variant="ghost"
          labelClassName="text-xs"
          fact="INV-0042 · sandbox"
        />
        <LedgerRow
          label="billed to"
          variant="ghost"
          labelClassName="text-xs"
          fact={DEMO_CUSTOMER}
        />
        <LedgerRow label="period" variant="ghost" labelClassName="text-xs" fact={period} />
        <LedgerRow
          label="status"
          variant="ghost"
          labelClassName="text-xs"
          fact="paid"
          factClassName="text-success-text"
        />
      </div>

      <ReceiptMarker>lines · each explained by its decision</ReceiptMarker>
      <div className="flex flex-col">
        <div className="flex items-baseline gap-2 py-[5px]">
          <span className="font-medium text-background-textContrast text-sm">Pro plan base</span>
          <span className="font-mono text-[10px] text-background-text">monthly</span>
          <Leader />
          <span className="whitespace-nowrap font-mono text-[11px] text-background-textContrast tabular-nums">
            ${BASE_FEE.toFixed(2)}
          </span>
        </div>
        {features
          .filter((f) => f.usage > 0)
          .map((f) => (
            <div key={f.id} className="flex items-baseline gap-2 py-[5px]">
              <span className="font-medium text-background-textContrast text-sm">
                {f.displayName}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-background-text">
                {qtyLabel(f)}
              </span>
              <Leader />
              <span className="whitespace-nowrap font-mono text-[11px] text-background-textContrast tabular-nums">
                ${featureCost(f).toFixed(2)}
              </span>
            </div>
          ))}
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-4 border-background-border border-t pt-3">
        <span className="font-medium text-background-textContrast text-sm">Total</span>
        <span className="font-mono font-semibold text-background-textContrast text-base tabular-nums">
          <AnimatedCounter value={total} prefix="$" decimals={2} />
        </span>
      </div>

      <div className="mt-auto pt-4">
        <p className="border-background-border border-t pt-3 font-mono text-[10px] text-background-text leading-4">
          every line above links to the decisions that accepted it — dispute answered from the same
          path, not from logs
        </p>
      </div>
    </div>
  )
}

// ============================================
// MAIN SECTION
// ============================================

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
            <PanelFrame className="shadow-ambient">
              <div className="flex items-baseline justify-between gap-3 border-background-border border-b px-4 py-3 sm:px-5">
                <span className="font-mono text-background-textContrast text-xs uppercase tracking-widest">
                  Pro plan
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="font-mono text-[10px] text-background-text">
                    {DEMO_CUSTOMER} · {DEMO_PLAN_VERSION}
                  </span>
                  <button
                    type="button"
                    onClick={handleReset}
                    aria-label="Reset the demo"
                    className={cn(
                      "inline-flex items-center gap-1 self-center rounded-sm font-mono text-[10px] text-background-text transition-colors duration-quick ease-out-quad hover:text-background-textContrast",
                      focusRing
                    )}
                  >
                    <RotateCcw aria-hidden className="size-3" />
                    reset
                  </button>
                </span>
              </div>

              <div className="flex-1">
                {features.map((feature) => (
                  <PlanRow
                    key={feature.id}
                    feature={feature}
                    isHit={hitRowId === feature.id}
                    onFire={handleFire}
                  />
                ))}
              </div>

              <div className="border-background-border border-t px-4 py-3 sm:px-5">
                <LedgerRow
                  label="base fee"
                  variant="ghost"
                  labelClassName="text-xs"
                  fact={`$${BASE_FEE.toFixed(2)} / mo`}
                />
                <LedgerRow
                  label="metered spend"
                  variant="ghost"
                  labelClassName="text-xs"
                  fact={<AnimatedCounter value={metered} prefix="$" decimals={2} />}
                  factClassName="text-background-textContrast"
                />
                <div className="mt-1 flex items-baseline justify-between gap-4 border-background-border border-t pt-2">
                  <div>
                    <span className="font-medium text-background-textContrast text-sm">
                      Accepted spend
                    </span>
                    <div className="mt-0.5">
                      <span className="font-mono text-[10px] text-background-text">
                        {acceptedActions} paid actions accepted
                      </span>
                    </div>
                  </div>
                  <span className="font-mono font-semibold text-background-textContrast text-lg tabular-nums">
                    <AnimatedCounter value={acceptedSpend} prefix="$" decimals={2} />
                  </span>
                </div>
              </div>
            </PanelFrame>

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
                    <DecisionReceipt
                      decision={lastDecision}
                      feature={lastFeature}
                      chipHit={chipHit}
                    />
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
