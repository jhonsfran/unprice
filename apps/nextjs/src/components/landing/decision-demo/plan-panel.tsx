"use client"

import { cn, focusRing } from "@unprice/ui/utils"
import { RotateCcw } from "lucide-react"
import type { ReactNode } from "react"
import { AnimatedCounter } from "../animated-counter"
import { Leader, LedgerRow } from "../station"
import {
  BASE_FEE,
  DEMO_CUSTOMER,
  DEMO_PLAN_VERSION,
  type Feature,
  pricingRuleLabel,
  rowStatus,
} from "./model"

export function PanelFrame({
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

// The plan sheet: the request side of the boundary — a ledger of paid actions
// with a live accepted-spend footer.
export function PlanPanel({
  features,
  hitRowId,
  metered,
  acceptedSpend,
  acceptedActions,
  onFire,
  onReset,
}: {
  features: Feature[]
  hitRowId: string | null
  metered: number
  acceptedSpend: number
  acceptedActions: number
  onFire: (id: string) => void
  onReset: () => void
}) {
  return (
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
            onClick={onReset}
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
            onFire={onFire}
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
            <span className="font-medium text-background-textContrast text-sm">Accepted spend</span>
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
  )
}
