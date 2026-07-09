"use client"

import { Badge } from "@unprice/ui/badge"
import { Input } from "@unprice/ui/input"
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
  editorOpen: boolean
  onFire: (id: string) => void
  onToggleEditor: (id: string) => void
  onConfigChange: (id: string, config: Partial<FeatureConfig>) => void
}

function PlanRow({
  feature,
  isHit,
  editorOpen,
  onFire,
  onToggleEditor,
  onConfigChange,
}: PlanRowProps) {
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
    <div className="border-background-line border-b last:border-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onFire(feature.id)}
          disabled={status === "blocked"}
          aria-label={`Send one ${feature.displayName} request · ${pricingRuleLabel(feature)}`}
          className={cn(
            "group min-w-0 flex-1 rounded-sm py-2.5 text-left transition-colors duration-quick ease-out-quad",
            focusRing,
            status === "blocked"
              ? "cursor-not-allowed"
              : "hover:bg-background-bgHover active:bg-background-bgActive"
          )}
        >
          <div className="flex items-baseline gap-2">
            <span
              aria-hidden
              data-dd-anchor={feature.id}
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
          <div className="mt-0.5 pl-[17px] font-mono text-[10px] text-background-text">
            {feature.call} · {pricingRuleLabel(feature)}
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

        {!isFlat && (
          <button
            type="button"
            onClick={() => onToggleEditor(feature.id)}
            aria-expanded={editorOpen}
            aria-label={`Edit the ${feature.displayName} guardrail`}
            className={cn(
              "shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-quick ease-out-quad",
              focusRing,
              status === "blocked"
                ? "border-danger-border text-danger-text"
                : status === "flagged"
                  ? "border-warning-border text-warning-text"
                  : "border-background-border text-background-text hover:border-background-borderHover hover:text-background-textContrast"
            )}
          >
            {feature.config.limitType}
          </button>
        )}
      </div>

      {editorOpen && !isFlat && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-background-line border-t border-dashed py-2 pl-[17px]">
          <span className="font-mono text-[10px] text-background-text uppercase tracking-widest">
            guardrail
          </span>
          <div className="flex items-center gap-2">
            <fieldset className="flex shrink-0 items-center rounded-sm border border-background-border p-px">
              <legend className="sr-only">{`${feature.displayName} limit type`}</legend>
              {(["hard", "soft"] as const).map((limitType) => (
                <button
                  key={limitType}
                  type="button"
                  onClick={() => onConfigChange(feature.id, { limitType })}
                  aria-pressed={feature.config.limitType === limitType}
                  className={cn(
                    "rounded-[3px] px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-quick ease-out-quad",
                    focusRing,
                    feature.config.limitType === limitType
                      ? "bg-background-bgActive text-background-textContrast"
                      : "text-background-text hover:text-background-textContrast"
                  )}
                >
                  {limitType}
                </button>
              ))}
            </fieldset>
            <Input
              type="number"
              min="1"
              step="1"
              value={feature.config.limit}
              onChange={(e) => {
                const val = Number.parseInt(e.target.value, 10)
                if (!Number.isNaN(val) && val >= 1) onConfigChange(feature.id, { limit: val })
              }}
              aria-label={`${feature.displayName} limit`}
              className="h-7 w-16 shrink-0 px-1.5 text-right font-mono text-[11px] text-background-textContrast"
            />
            <span className="font-mono text-[10px] text-background-text">{feature.unit}</span>
          </div>
        </div>
      )}
    </div>
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

  // The deny branch proves itself by absence — the same ghost grammar as the
  // money path's untouched wallet/ledger/invoice stations.
  const created: { label: string; fact: ReactNode; ghost: boolean }[] =
    pending || denied
      ? [
          { label: "work", fact: pending ? "—" : "never ran", ghost: true },
          { label: "cost created", fact: pending ? "—" : "none", ghost: true },
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
            label: "invoice line",
            fact: covered ? "no new line" : "explained · evidence attached",
            ghost: false,
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

interface InvoiceReceiptProps {
  features: Feature[]
  discountActive: boolean
  discountPercentage: number
}

function InvoiceReceipt({ features, discountActive, discountPercentage }: InvoiceReceiptProps) {
  const meteredPre = features.reduce((sum, f) => sum + featureCost(f), 0)
  const discount = discountActive ? meteredPre * (discountPercentage / 100) : 0
  const total = BASE_FEE + meteredPre - discount

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
        {discountActive && (
          <div className="flex items-baseline gap-2 py-[5px]">
            <span className="text-background-text text-sm">Volume pricing</span>
            <span className="font-mono text-[10px] text-background-text">
              −{discountPercentage}% metered
            </span>
            <Leader />
            <span className="whitespace-nowrap font-mono text-[11px] text-primary-text tabular-nums">
              −${discount.toFixed(2)}
            </span>
          </div>
        )}
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

export interface DecisionDemoProps {
  discountThreshold?: number
  discountPercentage?: number
  className?: string
}

export function DecisionDemo({
  discountThreshold = 10,
  discountPercentage = 20,
  className,
}: DecisionDemoProps) {
  const [features, setFeatures] = useState<Feature[]>(DEFAULT_FEATURES)
  const [lastDecision, setLastDecision] = useState<Decision | null>(null)
  const [acceptedActions, setAcceptedActions] = useState(0)
  const [view, setView] = useState<"decision" | "invoice">("decision")
  const [openEditor, setOpenEditor] = useState<string | null>(null)
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

  const discountActive = acceptedActions >= discountThreshold
  const metered = features.reduce((sum, f) => sum + featureCost(f), 0)
  const meteredBilled = discountActive ? metered * (1 - discountPercentage / 100) : metered
  const acceptedSpend = BASE_FEE + meteredBilled
  const lastFeature = lastDecision
    ? (features.find((f) => f.id === lastDecision.featureId) ?? null)
    : null

  // The request in flight: the row's station dot exits the plan sheet, fades
  // at the panel edge, re-emerges on the boundary connector's dashed line, and
  // fades again before the outcome chip — the chip's own highlight carries the
  // arrival, the dot only ever lives on rails (money-path grammar).
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
    const anchor = stage.querySelector<HTMLElement>(`[data-dd-anchor="${featureId}"]`)
    const plan = stage.querySelector<HTMLElement>("[data-dd-plan]")
    const line = stage.querySelector<HTMLElement>("[data-dd-line]")
    const stageBox = stage.getBoundingClientRect()
    const lineBox = line?.getBoundingClientRect()
    if (!dot || !anchor || !plan || !lineBox || lineBox.width === 0) {
      // Stacked layout: no horizontal boundary to travel — the chip flash and
      // the scroll-into-view carry the moment.
      land()
      return
    }

    const a = anchor.getBoundingClientRect()
    const start = {
      x: a.left - stageBox.left + a.width / 2,
      y: a.top - stageBox.top + a.height / 2,
    }
    const exitX = plan.getBoundingClientRect().right - stageBox.left - 10
    const lineY = lineBox.top - stageBox.top + lineBox.height / 2
    const lineX0 = lineBox.left - stageBox.left + 4
    const lineX1 = lineBox.right - stageBox.left - 4

    const SPEED = 0.9 // px per ms
    const FADE = 110
    const seg1 = Math.abs(exitX - start.x) / SPEED
    const seg2 = Math.abs(lineX1 - lineX0) / SPEED
    const total = FADE + seg1 + FADE + FADE + seg2 + FADE

    let t = 0
    const at = (ms: number) => {
      t += ms
      return Math.min(1, t / total)
    }
    const frame = (x: number, y: number, o: number, offset: number) => ({
      transform: `translate3d(${(x - 4.5).toFixed(1)}px, ${(y - 4.5).toFixed(1)}px, 0)`,
      opacity: o,
      offset,
    })

    const keyframes = [
      frame(start.x, start.y, 0, 0),
      frame(start.x, start.y, 1, at(FADE)),
      frame(exitX, start.y, 1, at(seg1)),
      frame(exitX, start.y, 0, at(FADE)),
      frame(lineX0, lineY, 0, at(0)),
      frame(lineX0, lineY, 1, at(FADE)),
      frame(lineX1, lineY, 1, at(seg2)),
      frame(lineX1, lineY, 0, at(FADE)),
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

      if (decision.kind === "deny") {
        // The natural next move after a deny is the rule itself — open it.
        setOpenEditor(featureId)
      } else if (decision.reason !== "already_included") {
        // Covered repeats (access.check on an active seat) run work but
        // consume nothing — no usage bump, no progress toward volume pricing.
        setFeatures((prev) =>
          prev.map((f) => (f.id === featureId ? { ...f, usage: f.usage + 1 } : f))
        )
        setAcceptedActions((prev) => prev + 1)
      }

      setLastDecision(decision)
      setView("decision")
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

  const handleConfigChange = useCallback((featureId: string, config: Partial<FeatureConfig>) => {
    setFeatures((prev) =>
      prev.map((f) => (f.id === featureId ? { ...f, config: { ...f.config, ...config } } : f))
    )
  }, [])

  const handleToggleEditor = useCallback((featureId: string) => {
    setOpenEditor((prev) => (prev === featureId ? null : featureId))
  }, [])

  const handleReset = useCallback(() => {
    flightRef.current?.cancel()
    setFeatures(DEFAULT_FEATURES)
    setLastDecision(null)
    setAcceptedActions(0)
    setView("decision")
    setOpenEditor(null)
    setHitRowId(null)
    setChipHit(false)
  }, [])

  return (
    <SectionShell id="demo" labelledBy="decision-demo-title" className={className}>
      <div className="max-w-2xl">
        <StationHeader index="03" label="The decision, live" fact="you send the request" />
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
        aria-label="An interactive plan sheet for acme-corp on pro@v3. The left panel lists the plan's paid actions — API requests, tiered storage, budgeted compute, and a flat premium support seat — each with a live usage meter and an editable hard or soft guardrail. Clicking a paid action sends one request across the request/decision boundary to the decision receipt, which answers allow, flagged, or deny before the work runs, with the evidence kept with the decision: the call, plan version, pricing rule, guardrail, and remaining budget. A denied request shows what it did not create — no work, no cost, no invoice line. The receipt's invoice view accrues the accepted charges into the invoice each decision explains."
        className="mt-10 sm:mt-12"
      >
        <Reveal>
          <div
            ref={stageRef}
            className="relative grid grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)] lg:gap-0"
          >
            {/* Plan sheet: the request side of the boundary */}
            <PanelFrame className="shadow-ambient">
              <div
                data-dd-plan
                className="flex items-baseline justify-between gap-3 border-background-border border-b px-4 py-3 sm:px-5"
              >
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

              <div className="flex-1 px-4 sm:px-5">
                {features.map((feature) => (
                  <PlanRow
                    key={feature.id}
                    feature={feature}
                    isHit={hitRowId === feature.id}
                    editorOpen={openEditor === feature.id}
                    onFire={handleFire}
                    onToggleEditor={handleToggleEditor}
                    onConfigChange={handleConfigChange}
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
                  fact={<AnimatedCounter value={meteredBilled} prefix="$" decimals={2} />}
                  factClassName="text-background-textContrast"
                />
                <div className="mt-1 flex items-baseline justify-between gap-4 border-background-border border-t pt-2">
                  <div>
                    <span className="font-medium text-background-textContrast text-sm">
                      Accepted spend
                    </span>
                    <div className="mt-0.5">
                      {discountActive ? (
                        <Badge variant="primary" className="text-[10px]">
                          volume pricing · −{discountPercentage}%
                        </Badge>
                      ) : (
                        <span className="font-mono text-[10px] text-background-text">
                          {acceptedActions} accepted ·{" "}
                          {Math.max(0, discountThreshold - acceptedActions)} to volume pricing
                        </span>
                      )}
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
                  <fieldset className="flex items-baseline gap-4">
                    <legend className="sr-only">Receipt view</legend>
                    {(["decision", "invoice"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setView(tab)}
                        aria-pressed={view === tab}
                        className={cn(
                          "rounded-sm border-b pb-0.5 font-mono text-xs uppercase tracking-widest transition-colors duration-quick ease-out-quad",
                          focusRing,
                          view === tab
                            ? "border-background-textContrast text-background-textContrast"
                            : "border-transparent text-background-text hover:text-background-textContrast"
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
                    <InvoiceReceipt
                      features={features}
                      discountActive={discountActive}
                      discountPercentage={discountPercentage}
                    />
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
