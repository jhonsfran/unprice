"use client"

import type { LucideIcon } from "lucide-react"
import { BarChart3, Check, Gauge, Minus, Package } from "lucide-react"

import { FEATURE_TYPES, FEATURE_TYPES_MAPS } from "@unprice/db/utils"
import type { FeatureType } from "@unprice/db/utils"
import { cn, focusRing } from "@unprice/ui/utils"

export const FEATURE_TYPE_ICON: Record<FeatureType, LucideIcon> = {
  flat: Minus,
  tier: BarChart3,
  usage: Gauge,
  package: Package,
}

const SHORT_LABEL: Record<FeatureType, string> = {
  flat: "Flat",
  tier: "Tiered",
  usage: "Usage",
  package: "Package",
}

const SUBTITLE: Record<FeatureType, string> = {
  flat: "Fixed amount every cycle.",
  tier: "Quantity is chosen at signup. Price changes with the chosen amount.",
  usage: "Charged on what they actually use, tracked over time.",
  package: "Sold in fixed-size bundles.",
}

export function PricingModelIcon({
  type,
  className,
}: {
  type: FeatureType
  className?: string
}) {
  const Icon = FEATURE_TYPE_ICON[type]
  return <Icon className={cn("size-3.5", className)} />
}

export function PricingModelBadge({
  type,
  className,
}: {
  type: FeatureType
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border bg-background-bgSubtle text-foreground",
        className
      )}
    >
      <PricingModelIcon type={type} />
    </div>
  )
}

export function PricingModelPicker({
  value,
  onChange,
  isDisabled,
}: {
  value: FeatureType | undefined
  onChange: (value: FeatureType) => void
  isDisabled?: boolean
}) {
  // biome-ignore lint/a11y/useSemanticElements: visually-rich radio cards — native <input type="radio"> doesn't accept this layout
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {FEATURE_TYPES.map((type) => {
        const selected = value === type
        const Icon = FEATURE_TYPE_ICON[type]
        return (
          <button
            key={type}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: visually-rich radio cards — native <input type="radio"> doesn't accept this layout
            role="radio"
            aria-checked={selected}
            disabled={isDisabled}
            onClick={() => !isDisabled && onChange(type)}
            className={cn(
              "group relative flex flex-col gap-2 rounded-md border bg-background-bgSubtle p-3 text-left transition-all",
              "hover:border-foreground/40",
              selected
                ? "border-primary bg-background-bgHover ring-1 ring-primary/40"
                : "border-input",
              isDisabled && "pointer-events-none opacity-50",
              focusRing
            )}
          >
            <div className="flex items-start justify-between">
              <div
                className={cn(
                  "flex size-7 items-center justify-center rounded border bg-background text-muted-foreground transition-colors",
                  selected && "border-primary text-primary"
                )}
              >
                <Icon className="size-3.5" />
              </div>
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-input"
                )}
              >
                {selected && <Check className="size-3" strokeWidth={3} />}
              </span>
            </div>
            <div className="space-y-0.5">
              <div className="font-semibold text-sm">
                {FEATURE_TYPES_MAPS[type].shortLabel ?? SHORT_LABEL[type]}
              </div>
              <div className="text-muted-foreground text-xs leading-snug">{SUBTITLE[type]}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Short context-aware copy for the CONFIGURE step subtitle.
 * Falls back to a sensible default if a specific case isn't covered.
 */
export function getConfigureSubtitle({
  featureType,
  usageMode,
}: {
  featureType: FeatureType | undefined
  usageMode?: string | undefined
}): string {
  if (!featureType) return "Pick a model first"
  if (featureType === "flat") return "Set the fixed price"
  if (featureType === "tier") return "Customer picks a quantity at signup"
  if (featureType === "package") return "Set the per-bundle price"
  if (featureType === "usage") {
    if (usageMode === "unit") return "Charged per unit consumed"
    if (usageMode === "tier") return "Charged in tiers as usage grows"
    if (usageMode === "package") return "Charged per bundle of usage"
    return "Charged based on actual consumption"
  }
  return ""
}
