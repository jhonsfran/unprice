"use client"

import { cn } from "@unprice/ui/utils"
import { m } from "framer-motion"
import {
  ArrowRight,
  Check,
  ChevronUp,
  CreditCard,
  FileText,
  Lock,
  Receipt,
  RotateCcw,
  Settings,
  X,
} from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"

// ============================================
// TYPES & CONFIGURATION
// ============================================

export type FeatureType = "usage" | "flat" | "tiered"

export interface Tier {
  upto: number | "unlimited"
  rate: number
}

export interface FeatureConfig {
  limitType: "hard" | "soft"
  limit: number
}

export interface Feature {
  id: string
  name: string
  displayName: string
  type: FeatureType
  rate: number
  tiers?: Tier[]
  unit: string
  tag: string
  usage: number
  config: FeatureConfig
  isBase?: boolean
}

export function calculateFeatureCost(
  feature: Feature,
  discountActive: boolean,
  discountPercentage: number
) {
  const effectiveMultiplier = discountActive ? 1 - discountPercentage / 100 : 1
  let cost = 0

  if (feature.type === "usage") {
    cost = feature.usage * feature.rate
  } else if (feature.type === "flat") {
    cost = feature.usage > 0 ? feature.rate : 0
  } else if (feature.type === "tiered" && feature.tiers) {
    let remainingUsage = feature.usage
    let lastUpto = 0
    for (const tier of feature.tiers) {
      const tierLimit = tier.upto === "unlimited" ? Number.POSITIVE_INFINITY : tier.upto
      const tierCapacity = tierLimit - lastUpto
      const usageInTier = Math.max(0, Math.min(remainingUsage, tierCapacity))
      cost += usageInTier * tier.rate
      remainingUsage -= usageInTier
      lastUpto = tierLimit
      if (remainingUsage <= 0) break
    }
  }

  return cost * effectiveMultiplier
}

export interface PricingHeroProps {
  headline?: string
  description?: string
  docsLinkText?: string
  onDocsClick?: () => void
  accentColor?: string
  discountThreshold?: number
  discountPercentage?: number
  className?: string
}

interface Particle {
  id: number
  x: number
  y: number
  targetX: number
  targetY: number
}

const heroImageVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 100,
      damping: 20,
      delay: 0.6,
    },
  },
}

const DEFAULT_FEATURES: Feature[] = [
  {
    id: "pro_plan",
    name: "pro_plan",
    displayName: "Pro Plan Base",
    type: "flat",
    rate: 19.0,
    unit: "mo",
    tag: "PLAN",
    usage: 1,
    isBase: true,
    config: { limitType: "soft", limit: 1 },
  },
  {
    id: "api_request",
    name: "api_request",
    displayName: "API Requests",
    type: "usage",
    rate: 0.1,
    unit: "requests",
    tag: "POST",
    usage: 0,
    config: { limitType: "hard", limit: 20 },
  },
  {
    id: "premium_support",
    name: "premium_support",
    displayName: "Premium Support",
    type: "flat",
    rate: 5.0,
    unit: "seat",
    tag: "FLAT",
    usage: 0,
    config: { limitType: "soft", limit: 5 },
  },
  {
    id: "storage_gb",
    name: "storage_gb",
    displayName: "Storage",
    type: "tiered",
    rate: 0.25, // Fallback rate
    tiers: [
      { upto: 2, rate: 0 }, // First 2GB free
      { upto: 5, rate: 0.5 }, // Next 3GB at 0.50
      { upto: "unlimited", rate: 0.8 }, // Then 0.80
    ],
    unit: "GB",
    tag: "S3",
    usage: 0,
    config: { limitType: "hard", limit: 10 },
  },
  {
    id: "compute_min",
    name: "compute_min",
    displayName: "Compute",
    type: "usage",
    rate: 0.15,
    unit: "GB-hrs",
    tag: "CPU",
    usage: 0,
    config: { limitType: "soft", limit: 50 },
  },
]

// ============================================
// ANIMATED COUNTER
// ============================================

function AnimatedCounter({
  value,
  prefix = "",
  decimals = 0,
  className,
}: {
  value: number
  prefix?: string
  decimals?: number
  className?: string
}) {
  const [displayValue, setDisplayValue] = useState(value)
  const previousValue = useRef(value)

  useEffect(() => {
    if (value !== previousValue.current) {
      const start = previousValue.current
      const end = value
      const duration = 150
      const startTime = performance.now()

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime
        const progress = Math.min(elapsed / duration, 1)
        const easeProgress = 1 - (1 - progress) ** 3
        const current = start + (end - start) * easeProgress
        setDisplayValue(current)
        if (progress < 1) requestAnimationFrame(animate)
      }

      requestAnimationFrame(animate)
      previousValue.current = value
    }
  }, [value])

  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {prefix}
      {displayValue.toFixed(decimals)}
    </span>
  )
}

// ============================================
// PARTICLE EFFECT
// ============================================

function ParticleEffect({ particles }: { particles: Particle[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-visible" aria-hidden="true">
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="absolute h-2.5 w-2.5 animate-particle rounded-full bg-primary"
          style={
            {
              left: particle.x,
              top: particle.y,
              "--target-x": `${particle.targetX - particle.x}px`,
              "--target-y": `${particle.targetY - particle.y}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

// ============================================
// DASHBOARD PANEL (Per-feature config + Invoice button)
// ============================================

interface DashboardPanelProps {
  features: Feature[]
  onFeatureConfigChange: (featureId: string, config: Partial<FeatureConfig>) => void
  onAddFeature: (feature: Omit<Feature, "id" | "usage" | "config">) => void
  onGenerateInvoice: () => void
  isOpen: boolean
  onClose: () => void
  disabled?: boolean
}

function DashboardPanel({
  features,
  onFeatureConfigChange,
  onAddFeature,
  onGenerateInvoice,
  isOpen,
  onClose,
  disabled,
}: DashboardPanelProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [newFeature, setNewFeature] = useState<Omit<Feature, "id" | "usage" | "config">>({
    name: "",
    displayName: "",
    type: "usage",
    rate: 0,
    unit: "events",
    tag: "NEW",
  })

  if (!isOpen) return null

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-lg border border-background-border bg-background-base p-4 font-mono text-xs",
        "transition-all duration-200",
        disabled && "pointer-events-none opacity-40"
      )}
    >
      <div className="mb-3 flex shrink-0 items-center justify-between border-background-line border-b pb-2">
        <div className="flex items-center gap-1.5">
          <Settings className="h-3 w-3 text-background-text" />
          <span className="font-bold text-[10px] text-background-textContrast uppercase tracking-widest">
            Configuration
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-background-text transition-colors hover:bg-background-bgHover hover:text-background-textContrast"
          aria-label="Close dashboard"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main Content Area: Scrollable features */}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="mb-2 flex items-center justify-between px-0.5">
          <h3 className="font-bold text-[9px] text-background-text uppercase tracking-widest">
            Features
          </h3>
          <button
            type="button"
            onClick={() => setIsAdding(!isAdding)}
            className={cn(
              "rounded px-2 py-0.5 font-bold text-[9px] transition-all",
              isAdding
                ? "bg-background-bgHover text-background-text"
                : "bg-primary-bg text-primary-text hover:bg-primary-bgHover"
            )}
          >
            {isAdding ? "Cancel" : "+ Add Feature"}
          </button>
        </div>

        {isAdding && (
          <div className="mb-4 space-y-2 rounded-md border border-primary-border bg-primary-bg/5 p-2 shadow-inner">
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="ml-1 font-bold text-[8px] text-background-text uppercase tracking-tighter">
                  Name
                </span>
                <input
                  placeholder="e.g. storage"
                  className="rounded border border-background-border bg-background-bg px-2 py-1 text-[10px] focus:border-primary-border focus:outline-none"
                  value={newFeature.displayName}
                  onChange={(e) =>
                    setNewFeature({
                      ...newFeature,
                      displayName: e.target.value,
                      name: e.target.value.toLowerCase().replace(/\s+/g, "_"),
                    })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="ml-1 font-bold text-[8px] text-background-text uppercase tracking-tighter">
                  Type
                </span>
                <select
                  className="rounded border border-background-border bg-background-bg px-2 py-1 text-[10px] focus:border-primary-border focus:outline-none"
                  value={newFeature.type}
                  onChange={(e) =>
                    setNewFeature({ ...newFeature, type: e.target.value as FeatureType })
                  }
                >
                  <option value="usage">Usage</option>
                  <option value="flat">Flat</option>
                  <option value="tiered">Tiered</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="ml-1 font-bold text-[8px] text-background-text uppercase tracking-tighter">
                  Rate ($)
                </span>
                <input
                  type="number"
                  placeholder="0.00"
                  className="w-full rounded border border-background-border bg-background-bg px-2 py-1 text-[10px] focus:border-primary-border focus:outline-none"
                  value={newFeature.rate}
                  onChange={(e) =>
                    setNewFeature({ ...newFeature, rate: Number.parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="ml-1 font-bold text-[8px] text-background-text uppercase tracking-tighter">
                  Unit
                </span>
                <input
                  placeholder="e.g. GB"
                  className="rounded border border-background-border bg-background-bg px-2 py-1 text-[10px] focus:border-primary-border focus:outline-none"
                  value={newFeature.unit}
                  onChange={(e) => setNewFeature({ ...newFeature, unit: e.target.value })}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (!newFeature.displayName) return
                onAddFeature(newFeature)
                setIsAdding(false)
                setNewFeature({
                  name: "",
                  displayName: "",
                  type: "usage",
                  rate: 0,
                  unit: "events",
                  tag: "NEW",
                })
              }}
              className="w-full rounded bg-primary py-1.5 font-bold text-[10px] text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              Add Feature
            </button>
          </div>
        )}

        <div className="space-y-2">
          {features.map((feature) => (
            <div
              key={feature.id}
              className="rounded-md border border-background-border bg-background-bgSubtle p-2 transition-colors hover:border-background-borderHover"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="max-w-[120px] truncate font-semibold text-[11px] text-background-textContrast">
                  {feature.displayName}
                </span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-bold text-[8px] uppercase tracking-tighter",
                    feature.config.limitType === "hard"
                      ? "bg-danger-bg text-danger-text"
                      : "bg-warning-bg text-warning-text"
                  )}
                >
                  {feature.config.limitType}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-0.5 rounded-md border border-background-border bg-background-bg p-0.5">
                  <button
                    type="button"
                    onClick={() => onFeatureConfigChange(feature.id, { limitType: "hard" })}
                    disabled={disabled}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-medium text-[9px] transition-all",
                      feature.config.limitType === "hard"
                        ? "bg-danger-solid text-white shadow-sm"
                        : "text-background-text hover:bg-background-bgSubtle hover:text-background-textContrast"
                    )}
                  >
                    hard
                  </button>
                  <button
                    type="button"
                    onClick={() => onFeatureConfigChange(feature.id, { limitType: "soft" })}
                    disabled={disabled}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-medium text-[9px] transition-all",
                      feature.config.limitType === "soft"
                        ? "bg-warning-solid text-white shadow-sm"
                        : "text-background-text hover:bg-background-bgSubtle hover:text-background-textContrast"
                    )}
                  >
                    soft
                  </button>
                </div>

                <div className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="number"
                    value={feature.config.limit}
                    onChange={(e) => {
                      const val = Number.parseFloat(e.target.value)
                      if (!Number.isNaN(val) && val >= 0) {
                        onFeatureConfigChange(feature.id, { limit: val })
                      }
                    }}
                    min="0"
                    step="1"
                    disabled={disabled || feature.isBase}
                    className="w-12 shrink-0 rounded border-background-border bg-background-bg px-1 py-0.5 text-right text-[10px] text-background-textContrast focus:border-primary-borderHover focus:outline-none disabled:cursor-not-allowed"
                  />
                  <span className="truncate font-mono text-[9px] text-background-text">
                    {feature.unit}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bill Customer Button - Sticky at bottom */}
      <div className="mt-auto shrink-0 pt-4">
        <button
          type="button"
          onClick={onGenerateInvoice}
          disabled={disabled}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2 font-bold font-mono text-[11px] text-primary-foreground shadow-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Receipt className="h-3.5 w-3.5" />
          Generate Invoice
        </button>
      </div>
    </div>
  )
}

// ============================================
// LIVE RESPONSE (richer JSON with breakdown)
// ============================================

interface LiveResponseProps {
  features: Feature[]
  activeFeatureId: string | null
  discountActive: boolean
  discountPercentage: number
  latency: number | null
  limitedFeature: Feature | null
  isOpen: boolean
  onClose: () => void
  flashError: boolean
}

// ============================================
// INVOICE PANEL (Visual representation of a bill)
// ============================================

interface InvoicePanelProps {
  features: Feature[]
  discountActive: boolean
  discountPercentage: number
  isOpen: boolean
  onClose: () => void
}

function InvoicePanel({
  features,
  discountActive,
  discountPercentage,
  isOpen,
  onClose,
}: InvoicePanelProps) {
  const totalBill = features.reduce(
    (sum, f) => sum + calculateFeatureCost(f, discountActive, discountPercentage),
    0
  )

  if (!isOpen) return null

  const today = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

  return (
    <div className="h-full rounded-lg border border-background-border bg-background-base p-6 font-primary shadow-sm">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-primary">
              <Receipt className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
            <span className="font-bold text-background-textContrast text-sm uppercase tracking-tight">
              Invoice
            </span>
          </div>
          <p className="font-mono text-[10px] text-background-text">INV-2024-001</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-background-text hover:text-background-textContrast"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-6 flex justify-between font-mono text-[10px]">
        <div>
          <p className="font-bold text-background-textContrast uppercase">Billed To</p>
          <p className="text-background-text">Acme Corp</p>
          <p className="text-background-text">billing@acme.com</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-background-textContrast uppercase">Date</p>
          <p className="text-background-text">{today}</p>
        </div>
      </div>

      <div className="mb-6">
        <table className="w-full text-left">
          <thead>
            <tr className="border-background-line border-b font-mono text-[9px] text-background-text uppercase">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[10px]">
            {features
              .filter((f) => f.usage > 0 || f.isBase)
              .map((f) => {
                const cost = calculateFeatureCost(f, discountActive, discountPercentage)
                return (
                  <tr key={f.id} className="border-background-line border-b last:border-0">
                    <td className="py-2 text-background-textContrast">{f.displayName}</td>
                    <td className="py-2 text-right text-background-text">
                      {f.isBase ? "1" : f.usage}
                    </td>
                    <td className="py-2 text-right text-background-textContrast">
                      ${cost.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <div className="mt-auto space-y-2 border-background-line border-t pt-4">
        {discountActive && (
          <div className="flex justify-between font-mono text-[10px]">
            <span className="text-success-text">Volume Discount ({discountPercentage}%)</span>
            <span className="text-success-text">
              -$
              {((totalBill / (1 - discountPercentage / 100)) * (discountPercentage / 100)).toFixed(
                2
              )}
            </span>
          </div>
        )}
        <div className="flex justify-between font-bold text-background-textContrast">
          <span className="text-xs uppercase">Total Amount</span>
          <span className="text-sm tabular-nums">${totalBill.toFixed(2)}</span>
        </div>
      </div>

      <div className="mt-6">
        <div className="rounded border border-success-border/50 bg-success-bg/30 p-2 text-center">
          <span className="font-bold font-mono text-[9px] text-success-text uppercase tracking-wider">
            Status: Paid
          </span>
        </div>
      </div>
    </div>
  )
}

// ============================================
// PRICING CARD PANEL (Marketing view of the plan)
// ============================================

interface PricingPanelProps {
  features: Feature[]
  isOpen: boolean
  onClose: () => void
}

function PricingPanel({ features, isOpen, onClose }: PricingPanelProps) {
  if (!isOpen) return null

  return (
    <div className="flex h-full flex-col rounded-lg border border-background-border bg-background-base p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-semibold text-[10px] text-primary uppercase tracking-wider">
          Pro Plan
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-background-text hover:text-background-textContrast"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-6">
        <div className="flex items-baseline gap-1">
          <span className="font-bold text-3xl text-background-textContrast tracking-tight">
            $19
          </span>
          <span className="text-background-text text-sm">/mo</span>
        </div>
        <p className="mt-1 text-[11px] text-background-text italic">+ pay-as-you-go usage fees</p>
      </div>

      <div className="custom-scrollbar mb-8 flex-1 space-y-3 overflow-y-auto pr-2">
        {features.map((feature) => (
          <div key={feature.id} className="flex items-start gap-2.5">
            <div className="mt-0.5 rounded-full bg-success-bg p-0.5 text-success-text">
              <Check className="h-3 w-3" />
            </div>
            <div className="flex flex-col">
              <span className="font-medium text-background-textContrast text-xs leading-tight">
                {feature.displayName}
              </span>
              {!feature.isBase && (
                <span className="text-[10px] text-background-text">
                  {feature.type === "usage" && `$${feature.rate.toFixed(2)} per ${feature.unit}`}
                  {feature.type === "flat" && `$${feature.rate.toFixed(2)} fixed fee`}
                  {feature.type === "tiered" && "Tiered pricing enabled"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="w-full rounded-lg bg-primary py-2.5 font-bold text-primary-foreground text-xs transition-opacity hover:opacity-90"
      >
        Get Started with Pro
      </button>

      <p className="mt-3 text-center font-mono text-[9px] text-background-text">
        No credit card required for 14 days
      </p>
    </div>
  )
}

function LiveResponse({
  features,
  activeFeatureId,
  discountActive,
  discountPercentage,
  latency,
  limitedFeature,
  isOpen,
  onClose,
  flashError,
}: LiveResponseProps) {
  const activeFeature = features.find((f) => f.id === activeFeatureId)

  if (!isOpen) return null

  // Show limit response when a feature is limited
  if (limitedFeature) {
    const isHard = limitedFeature.config.limitType === "hard"

    return (
      <div
        className={cn(
          "h-full rounded-lg border bg-background-base p-4 font-mono text-xs transition-all duration-100",
          flashError
            ? isHard
              ? "border-danger-solid bg-danger-bgActive"
              : "border-warning-solid bg-warning-bgActive"
            : isHard
              ? "border-danger-border"
              : "border-warning-border"
        )}
      >
        <div
          className={cn(
            "mb-3 flex items-center justify-between border-b pb-2",
            isHard ? "border-danger-line" : "border-warning-line"
          )}
        >
          <span
            className={cn(
              "font-bold text-[10px] uppercase tracking-wider",
              isHard ? "text-danger-text" : "text-warning-text"
            )}
          >
            {isHard ? "HTTP 429 Too Many Requests" : "HTTP 200 Warning"}
          </span>
          <div className="flex items-center gap-2">
            {latency !== null && (
              <span
                className={cn("text-[10px]", isHard ? "text-danger-text" : "text-warning-text")}
              >
                {latency}ms
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-background-text hover:text-background-textContrast"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <pre className="overflow-auto bg-transparent text-[11px] text-background-text leading-relaxed">
          <code>
            {`{
  "allowed": ${isHard ? "false" : "true"},
  "deniedReason": ${isHard ? '"LIMIT_EXCEEDED"' : "null"},
  "usage": `}
            <AnimatedCounter value={limitedFeature.usage} />
            {`,
  "cost": `}
            <AnimatedCounter
              value={calculateFeatureCost(limitedFeature, discountActive, discountPercentage)}
              decimals={2}
            />
            {`,
  "rate": "$${limitedFeature.rate.toFixed(2)} / ${limitedFeature.unit}",
  "limit": ${limitedFeature.config.limit},
  "remaining": 0,
  "message": "${isHard ? "Limit exceeded" : "Usage threshold reached"}"
}`}
          </code>
        </pre>
      </div>
    )
  }

  return (
    <div className="h-full rounded-lg border border-background-border bg-background-base p-4 font-mono text-xs">
      <div className="mb-3 flex items-center justify-between border-background-line border-b pb-2">
        <span className="text-[10px] text-background-text uppercase tracking-wider">
          response.json
        </span>
        <div className="flex items-center gap-2">
          {latency !== null && <span className="text-[10px] text-success-text">{latency}ms</span>}
          <button
            type="button"
            onClick={onClose}
            className="text-background-text hover:text-background-textContrast"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <pre className="overflow-auto bg-transparent text-[11px] text-background-text leading-relaxed">
        <code>
          {!activeFeature ? (
            `{
  "status": "waiting_for_event",
  "message": "Click a feature to report usage"
}`
          ) : (
            <>
              {`{
  "allowed": true,
  "usage": `}
              <AnimatedCounter value={activeFeature.usage} />
              {`,
  "cost": `}
              <AnimatedCounter
                value={calculateFeatureCost(activeFeature, discountActive, discountPercentage)}
                decimals={2}
              />
              {`,
  "rate": "$${activeFeature.rate.toFixed(2)} / ${activeFeature.unit}",
  "limit": ${activeFeature.config.limit},
  "remaining": `}
              <AnimatedCounter
                value={Math.max(0, activeFeature.config.limit - activeFeature.usage)}
              />
              {`,
  "message": "Usage reported successfully"
}`}
            </>
          )}
        </code>
      </pre>
    </div>
  )
}

// ============================================
// FEATURE ROW (clickable to send event)
// ============================================

interface FeatureRowProps {
  feature: Feature
  onClick: (e: React.MouseEvent<HTMLButtonElement>, featureId: string) => void
  isPressed: boolean
  isActive: boolean
  isLimited: boolean
  discountActive: boolean
  discountPercentage: number
}

function FeatureRow({
  feature,
  onClick,
  isPressed,
  isActive,
  isLimited,
  discountActive,
  discountPercentage,
}: FeatureRowProps) {
  const spendProgress = (feature.usage / feature.config.limit) * 100

  return (
    <button
      type="button"
      onClick={(e) => onClick(e, feature.id)}
      disabled={isLimited && feature.config.limitType === "hard"}
      className={cn(
        "flex w-full items-center justify-between rounded-lg p-3 transition-all duration-150",
        "border border-background-border bg-background-base",
        !feature.isBase &&
          "hover:border-background-borderHover hover:bg-background-bgHover active:scale-[0.98]",
        feature.isBase && "cursor-default",
        isActive &&
          "border-primary-border bg-background-bgHover shadow-[0_0_20px_rgba(var(--primary-9),0.12)]",
        isPressed && !feature.isBase && "scale-[0.98] bg-background-bg",
        isLimited &&
          feature.config.limitType === "soft" &&
          "border-warning-border bg-warning-bgSubtle"
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[10px]",
            feature.isBase
              ? "border-success-border bg-success-bg text-success-text"
              : isLimited && feature.config.limitType === "hard"
                ? "border-danger-border bg-danger-bg text-danger-text"
                : isLimited && feature.config.limitType === "soft"
                  ? "border-warning-border bg-warning-bg text-warning-text"
                  : isActive
                    ? "border-primary-border bg-primary-bg text-primary-text"
                    : "border-background-border bg-background-bgSubtle text-background-text"
          )}
        >
          [{feature.tag}]
        </span>
        <div className="text-left">
          <div className="font-medium text-foreground text-sm">{feature.displayName}</div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {feature.isBase ? (
              <span className="text-success-text">Always included</span>
            ) : (
              <>
                {feature.type === "usage" && (
                  <>
                    <span className={discountActive ? "text-success-text" : "text-background-text"}>
                      ${feature.rate.toFixed(2)}
                    </span>
                    <span className="text-background-text">/{feature.unit}</span>
                  </>
                )}
                {feature.type === "flat" && (
                  <span className={discountActive ? "text-success-text" : "text-background-text"}>
                    ${feature.rate.toFixed(2)} fixed
                  </span>
                )}
                {feature.type === "tiered" && (
                  <span className={discountActive ? "text-success-text" : "text-background-text"}>
                    Tiered pricing
                  </span>
                )}
                {discountActive && (
                  <span className="ml-1 text-success-text">(-{discountPercentage}%)</span>
                )}
              </>
            )}
          </div>
          {/* Per-feature progress bar */}
          {!feature.isBase && (
            <div className="mt-1 h-0.5 w-24 overflow-hidden rounded-full bg-background-line">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-200",
                  spendProgress >= 100
                    ? feature.config.limitType === "hard"
                      ? "bg-danger-solid"
                      : "bg-warning-solid"
                    : spendProgress > 80
                      ? feature.config.limitType === "hard"
                        ? "bg-danger-solidHover"
                        : "bg-warning-solidHover"
                      : "bg-primary-solid"
                )}
                style={{ width: `${Math.min(spendProgress, 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono font-semibold text-foreground text-lg tabular-nums">
          {feature.isBase ? (
            <span>
              $<AnimatedCounter value={feature.rate} decimals={2} />
            </span>
          ) : (
            <AnimatedCounter value={feature.usage} />
          )}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {feature.isBase ? "per month" : feature.unit}
        </div>
        <div
          className={cn(
            "mt-0.5 min-h-[14px] font-mono text-[9px] transition-opacity",
            isLimited ? "opacity-100" : "opacity-0",
            feature.config.limitType === "hard" ? "text-danger-text" : "text-warning-text"
          )}
        >
          {feature.config.limitType === "hard" ? (
            <span className="flex items-center justify-end gap-1">
              <Lock className="h-3 w-3" />
              <span>blocked</span>
            </span>
          ) : (
            "warning"
          )}
        </div>
      </div>
    </button>
  )
}

// ============================================
// MAIN COMPONENT
// ============================================

export function PricingHero({
  headline = "Put a budget around the expensive action.",
  description = "Report usage and watch over-budget calls get blocked before they run.",
  docsLinkText = "Read the Docs",
  accentColor,
  discountThreshold = 10,
  discountPercentage = 20,
  className,
}: PricingHeroProps) {
  const [features, setFeatures] = useState<Feature[]>(DEFAULT_FEATURES)
  const [totalClicks, setTotalClicks] = useState(0)
  const [particles, setParticles] = useState<Particle[]>([])
  const [pressedFeature, setPressedFeature] = useState<string | null>(null)
  const [activeFeature, setActiveFeature] = useState<string | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const [limitedFeatures, setLimitedFeatures] = useState<Set<string>>(new Set())
  const [currentLimitedFeature, setCurrentLimitedFeature] = useState<Feature | null>(null)
  const [shake, setShake] = useState(false)
  const [flashError, setFlashError] = useState(false)
  type ActivePanel = "dashboard" | "response" | "invoice" | "pricing"
  const [activePanel, setActivePanel] = useState<ActivePanel | null>("response")
  const containerRef = useRef<HTMLDivElement>(null)
  const responseRef = useRef<HTMLDivElement>(null)
  const particleId = useRef(0)

  const discountActive = totalClicks >= discountThreshold
  const currentSpend = features.reduce(
    (sum, f) => sum + calculateFeatureCost(f, discountActive, discountPercentage),
    0
  )

  const anyLimited = limitedFeatures.size > 0
  const dynamicHeadline = anyLimited ? "Limit Reached." : headline
  const dynamicDescription = anyLimited
    ? currentLimitedFeature?.config.limitType === "hard"
      ? `Hard limit of ${currentLimitedFeature.config.limit} ${currentLimitedFeature.unit} reached.`
      : `Soft limit warning at ${currentLimitedFeature?.config.limit} ${currentLimitedFeature?.unit} triggered.`
    : description

  const handleFeatureConfigChange = useCallback(
    (featureId: string, configUpdate: Partial<FeatureConfig>) => {
      setFeatures((prev) =>
        prev.map((f) =>
          f.id === featureId ? { ...f, config: { ...f.config, ...configUpdate } } : f
        )
      )
      // If limit increases, maybe feature is no longer limited
      if (configUpdate.limit !== undefined) {
        const feature = features.find((f) => f.id === featureId)
        if (feature) {
          if (feature.usage < configUpdate.limit) {
            setLimitedFeatures((prev) => {
              const next = new Set(prev)
              next.delete(featureId)
              return next
            })
            if (currentLimitedFeature?.id === featureId) {
              setCurrentLimitedFeature(null)
            }
          }
        }
      }
    },
    [features, currentLimitedFeature]
  )

  const handleFeatureClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, featureId: string) => {
      const feature = features.find((f) => f.id === featureId)
      if (!feature || feature.isBase) return

      const nextUsage = feature.usage + 1
      const wouldExceed = nextUsage > feature.config.limit

      setActiveFeature(featureId)

      if (wouldExceed) {
        // Feature limit reached
        setLimitedFeatures((prev) => new Set(prev).add(featureId))
        setCurrentLimitedFeature(feature)
        setLatency(Math.floor(Math.random() * 10) + 3)
        setShake(true)
        // Bug fix: Close dashboard and force open response when limit is reached
        setActivePanel("response")
        // Flash the error/warning
        setFlashError(true)
        setTimeout(() => setFlashError(false), 150)
        setTimeout(() => setShake(false), 500)

        // For soft limits, still allow the event but show warning
        if (feature.config.limitType === "soft") {
          setFeatures((prev) =>
            prev.map((f) => (f.id === featureId ? { ...f, usage: f.usage + 1 } : f))
          )
          setTotalClicks((prev) => prev + 1)
        }
        return
      }

      // Clear limited state for this feature if it was soft limited before
      if (limitedFeatures.has(featureId)) {
        setLimitedFeatures((prev) => {
          const next = new Set(prev)
          next.delete(featureId)
          return next
        })
        if (currentLimitedFeature?.id === featureId) {
          setCurrentLimitedFeature(null)
        }
      }

      const simulatedLatency = Math.floor(Math.random() * 24) + 8
      setLatency(simulatedLatency)

      setFeatures((prev) =>
        prev.map((f) => (f.id === featureId ? { ...f, usage: f.usage + 1 } : f))
      )
      setTotalClicks((prev) => prev + 1)

      // Particles fly from clicked feature to response panel
      if (containerRef.current && responseRef.current) {
        const buttonRect = e.currentTarget.getBoundingClientRect()
        const containerRect = containerRef.current.getBoundingClientRect()
        const responseRect = responseRef.current.getBoundingClientRect()

        const particleCount = 3
        const newParticles: Particle[] = []

        for (let i = 0; i < particleCount; i++) {
          const offsetX = (Math.random() - 0.5) * 30
          const offsetY = (Math.random() - 0.5) * 20
          const startX = buttonRect.left - containerRect.left + buttonRect.width / 2 + offsetX
          const startY = buttonRect.top - containerRect.top + buttonRect.height / 2 + offsetY
          const targetX =
            responseRect.left -
            containerRect.left +
            responseRect.width / 2 +
            (Math.random() - 0.5) * 60
          const targetY = responseRect.top - containerRect.top + 40 + (Math.random() - 0.5) * 30

          newParticles.push({
            id: particleId.current++,
            x: startX,
            y: startY,
            targetX,
            targetY,
          })
        }

        setParticles((prev) => [...prev, ...newParticles])
        setTimeout(() => {
          setParticles((prev) => prev.filter((p) => !newParticles.find((np) => np.id === p.id)))
        }, 500)
      }

      setPressedFeature(featureId)
      setTimeout(() => setPressedFeature(null), 100)
    },
    [features, discountActive, discountPercentage, limitedFeatures, currentLimitedFeature]
  )

  const handleReset = useCallback(() => {
    setLimitedFeatures(new Set())
    setCurrentLimitedFeature(null)
    setFeatures(DEFAULT_FEATURES.map((f) => ({ ...f, usage: f.isBase ? 1 : 0 })))
    setTotalClicks(0)
    setLatency(null)
    setActiveFeature(null)
  }, [])

  const handleIncreaseLimit = useCallback(() => {
    if (currentLimitedFeature) {
      setFeatures((prev) =>
        prev.map((f) =>
          f.id === currentLimitedFeature.id
            ? { ...f, config: { ...f.config, limit: f.config.limit * 2 } }
            : f
        )
      )
      setLimitedFeatures((prev) => {
        const next = new Set(prev)
        next.delete(currentLimitedFeature.id)
        return next
      })
      setCurrentLimitedFeature(null)
    }
  }, [currentLimitedFeature])

  const handleAddFeature = useCallback(
    (newFeatureData: Omit<Feature, "id" | "usage" | "config">) => {
      const id = `${newFeatureData.name}_${Math.random().toString(36).substr(2, 9)}`

      // Determine a tag based on the type if one wasn't provided or is default
      let tag = newFeatureData.tag
      if (tag === "NEW") {
        if (newFeatureData.type === "usage") tag = "POST"
        else if (newFeatureData.type === "flat") tag = "FIXED"
        else tag = "TIER"
      }

      const feature: Feature = {
        ...newFeatureData,
        id,
        tag,
        usage: 0,
        config: { limitType: "soft", limit: 100 },
      }
      setFeatures((prev) => [...prev, feature])
    },
    []
  )

  const handleGenerateInvoice = useCallback(() => {
    setActivePanel("invoice")
  }, [])

  const accentStyle = accentColor ? ({ "--accent-custom": accentColor } as React.CSSProperties) : {}

  const showSidePanel = !!activePanel

  return (
    <m.section
      variants={heroImageVariants}
      initial="hidden"
      animate="visible"
      className={cn(
        "mx-auto my-24 flex w-full max-w-6xl items-center justify-center px-6",
        className
      )}
      style={accentStyle}
      aria-labelledby="hero-headline"
    >
      <div className="w-full">
        {/* Header */}
        <header className="mx-auto mb-8 max-w-2xl text-center">
          <h2
            id="hero-headline"
            className={cn(
              "mb-3 text-balance font-bold text-3xl tracking-[-0.04em] transition-colors duration-500 md:text-4xl lg:text-5xl",
              anyLimited &&
                currentLimitedFeature?.config.limitType === "hard" &&
                "text-danger-text",
              anyLimited &&
                currentLimitedFeature?.config.limitType === "soft" &&
                "text-warning-text",
              !anyLimited && "text-background-textContrast"
            )}
          >
            {dynamicHeadline}
          </h2>
          <p className="mb-3 font-mono text-background-text text-sm md:text-base">
            {dynamicDescription}
          </p>
          <button
            type="button"
            onClick={() => {
              window.open("https://docs.unprice.dev", "_blank")
            }}
            className="group inline-flex items-center gap-1.5 font-mono text-background-text text-xs transition-colors hover:text-background-textContrast"
          >
            {docsLinkText}
            <ArrowRight
              className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
        </header>

        {/* Main Content: Card + Side Panel */}
        <div
          ref={containerRef}
          className="relative mx-auto flex max-w-4xl flex-col gap-4 lg:flex-row"
        >
          <ParticleEffect particles={particles} />

          {/* Pricing Card */}
          <div
            className={cn(
              "relative flex flex-1 flex-col rounded-xl border bg-background transition-all duration-300 lg:max-w-md",
              anyLimited &&
                currentLimitedFeature?.config.limitType === "hard" &&
                "border-danger-border",
              anyLimited &&
                currentLimitedFeature?.config.limitType === "soft" &&
                "border-warning-border",
              !anyLimited && "border-background-border"
            )}
          >
            {/* Plan Header */}
            <div className="border-background-border border-b p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-foreground text-lg">Pro Plan</h2>
                  <p className="font-mono text-[10px] text-background-text">Usage-based billing</p>
                </div>
                {discountActive && (
                  <span className="rounded border border-success-border bg-success-bg px-2 py-1 font-mono text-[10px] text-success-text">
                    {discountPercentage}% discount
                  </span>
                )}
              </div>
            </div>

            {/* Features List */}
            <div
              className={cn(
                "custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-4 transition-opacity duration-300"
              )}
            >
              {features.map((feature) => (
                <FeatureRow
                  key={feature.id}
                  feature={feature}
                  onClick={handleFeatureClick}
                  isPressed={pressedFeature === feature.id}
                  isActive={activeFeature === feature.id}
                  isLimited={limitedFeatures.has(feature.id)}
                  discountActive={discountActive}
                  discountPercentage={discountPercentage}
                />
              ))}
            </div>

            {/* Locked State Actions */}
            <div
              className={cn(
                "overflow-hidden transition-all duration-300 ease-in-out",
                anyLimited ? "max-h-24 opacity-100" : "max-h-0 opacity-0"
              )}
            >
              <div
                className={cn(
                  "flex justify-center gap-2 border-t p-4",
                  currentLimitedFeature?.config.limitType === "hard"
                    ? "border-danger-border"
                    : "border-warning-border",
                  shake && "animate-shake"
                )}
              >
                <button
                  type="button"
                  onClick={handleIncreaseLimit}
                  className="flex items-center gap-1.5 rounded-lg bg-primary-solid px-4 py-2 font-mono text-primary-foreground text-xs transition-opacity hover:bg-primary-solidHover"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                  Increase Limit
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex items-center gap-1.5 rounded-lg border border-background-border bg-background-bg px-4 py-2 font-mono text-background-text text-xs transition-colors hover:bg-background-bgHover"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
              </div>
            </div>

            {/* Total Summary */}
            <div className="border-background-border border-t p-4">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-foreground text-sm">Total</h3>
                  <p className="font-mono text-[10px] text-background-text">
                    {totalClicks} events processed
                  </p>
                </div>
                <div className="text-right">
                  <div
                    className={cn(
                      "font-bold font-mono text-2xl tabular-nums transition-colors",
                      discountActive ? "text-success-text" : "text-foreground"
                    )}
                  >
                    <AnimatedCounter value={currentSpend} prefix="$" decimals={2} />
                  </div>
                </div>
              </div>

              {/* Discount status */}
              <div className="flex items-center justify-between font-mono text-[10px] text-background-text">
                <span className={discountActive ? "text-success-text" : ""}>
                  {discountActive
                    ? `${discountPercentage}% volume discount active`
                    : `${Math.max(0, discountThreshold - totalClicks)} events to unlock discount`}
                </span>
              </div>
            </div>

            {/* Footer with toggle icons */}
            <div className="flex shrink-0 items-center justify-center gap-2 border-background-border border-t p-3">
              <button
                type="button"
                onClick={() => setActivePanel(activePanel === "dashboard" ? null : "dashboard")}
                className={cn(
                  "rounded-lg border p-2 transition-colors",
                  activePanel === "dashboard"
                    ? "border-primary-border bg-primary-bg text-primary-text"
                    : "border-background-border bg-background-bg text-background-text hover:border-background-borderHover hover:text-background-textContrast"
                )}
                aria-label="Toggle dashboard"
                aria-expanded={activePanel === "dashboard"}
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setActivePanel(activePanel === "response" ? null : "response")}
                className={cn(
                  "rounded-lg border p-2 transition-colors",
                  activePanel === "response"
                    ? "border-primary-border bg-primary-bg text-primary-text"
                    : "border-background-border bg-background-bg text-background-text hover:border-background-borderHover hover:text-background-textContrast"
                )}
                aria-label="Toggle response"
                aria-expanded={activePanel === "response"}
              >
                <FileText className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setActivePanel(activePanel === "invoice" ? null : "invoice")}
                className={cn(
                  "rounded-lg border p-2 transition-colors",
                  activePanel === "invoice"
                    ? "border-primary-border bg-primary-bg text-primary-text"
                    : "border-background-border bg-background-bg text-background-text hover:border-background-borderHover hover:text-background-textContrast"
                )}
                aria-label="Toggle invoice"
                aria-expanded={activePanel === "invoice"}
              >
                <Receipt className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setActivePanel(activePanel === "pricing" ? null : "pricing")}
                className={cn(
                  "rounded-lg border p-2 transition-colors",
                  activePanel === "pricing"
                    ? "border-primary-border bg-primary-bg text-primary-text"
                    : "border-background-border bg-background-bg text-background-text hover:border-background-borderHover hover:text-background-textContrast"
                )}
                aria-label="Toggle pricing"
                aria-expanded={activePanel === "pricing"}
              >
                <CreditCard className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Side Panel (Dashboard or Response) - Right on desktop, below on mobile */}
          <div
            ref={responseRef}
            className={cn("flex-1 transition-all duration-300", !showSidePanel && "lg:hidden")}
          >
            {activePanel === "dashboard" && (
              <DashboardPanel
                features={features}
                onFeatureConfigChange={handleFeatureConfigChange}
                onAddFeature={handleAddFeature}
                onGenerateInvoice={handleGenerateInvoice}
                isOpen={true}
                onClose={() => setActivePanel(null)}
                disabled={false}
              />
            )}
            {activePanel === "response" && (
              <LiveResponse
                features={features}
                activeFeatureId={activeFeature}
                discountActive={discountActive}
                discountPercentage={discountPercentage}
                latency={latency}
                limitedFeature={currentLimitedFeature}
                isOpen={true}
                onClose={() => setActivePanel(null)}
                flashError={flashError}
              />
            )}
            {activePanel === "invoice" && (
              <InvoicePanel
                features={features}
                discountActive={discountActive}
                discountPercentage={discountPercentage}
                isOpen={true}
                onClose={() => setActivePanel(null)}
              />
            )}
            {activePanel === "pricing" && (
              <PricingPanel
                features={features}
                isOpen={true}
                onClose={() => setActivePanel(null)}
              />
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes particle-fly {
          0% { opacity: 1; transform: translate(0, 0) scale(1); }
          70% { opacity: 1; }
          100% { opacity: 0; transform: translate(var(--target-x), var(--target-y)) scale(0.2); }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
        :global(.animate-particle) {
          animation: particle-fly 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards;
        }
        :global(.animate-shake) {
          animation: shake 0.6s ease-in-out;
        }
        :global(.custom-scrollbar::-webkit-scrollbar) {
          width: 4px;
        }
        :global(.custom-scrollbar::-webkit-scrollbar-track) {
          background: transparent;
        }
        :global(.custom-scrollbar::-webkit-scrollbar-thumb) {
          background: var(--background-border);
          border-radius: 10px;
        }
        :global(.custom-scrollbar::-webkit-scrollbar-thumb:hover) {
          background: var(--background-text);
        }
      `}</style>
    </m.section>
  )
}
