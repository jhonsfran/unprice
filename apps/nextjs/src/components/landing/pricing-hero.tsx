"use client"

import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { cn, focusRing } from "@unprice/ui/utils"
import { m } from "framer-motion"
import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronUp,
  CreditCard,
  FileText,
  Lock,
  type LucideIcon,
  Plus,
  Receipt,
  RotateCcw,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react"
import type React from "react"
import { useCallback, useRef, useState } from "react"
import { AnimatedCounter } from "./animated-counter"

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

const DEMO_PLAN_VERSION = "pro@v3"
const DEMO_CUSTOMER = "acme-corp"

function getRuntimeCall(feature: Feature) {
  if (feature.id === "compute_min") return "runs.start"
  if (feature.type === "flat") return "access.check"
  return "usage.consume"
}

function getFeaturePricingLabel(feature: Feature) {
  if (feature.type === "usage") return `$${feature.rate.toFixed(2)} / ${feature.unit}`
  if (feature.type === "flat") return `$${feature.rate.toFixed(2)} fixed`
  return "tiered pricing"
}

function getRemainingUsage(feature: Feature) {
  return Math.max(0, feature.config.limit - feature.usage)
}

function getEvidenceTrail(feature: Feature) {
  return [
    { label: "Customer", value: DEMO_CUSTOMER },
    { label: "Plan version", value: DEMO_PLAN_VERSION },
    { label: "Pricing rule", value: getFeaturePricingLabel(feature) },
    {
      label: "Guardrail",
      value: `${feature.config.limitType} limit · ${feature.config.limit} ${feature.unit}`,
    },
  ]
}

export interface PricingHeroProps {
  headline?: string
  description?: string
  docsLinkText?: string
  discountThreshold?: number
  discountPercentage?: number
  className?: string
}

type ActivePanel = "dashboard" | "response" | "invoice" | "pricing"

const PANEL_VIEWS: { id: ActivePanel; label: string; icon: LucideIcon }[] = [
  { id: "dashboard", label: "plan guardrails", icon: Settings },
  { id: "response", label: "decision trail", icon: FileText },
  { id: "invoice", label: "invoice", icon: Receipt },
  { id: "pricing", label: "pricing card", icon: CreditCard },
]

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
// PARTICLE EFFECT
// ============================================

function ParticleEffect({ particles }: { particles: Particle[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-visible" aria-hidden="true">
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="absolute h-2.5 w-2.5 animate-particle rounded-full bg-info"
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
// PLAN GUARDRAILS PANEL (Per-feature limits + invoice evidence button)
// ============================================

interface DashboardPanelProps {
  features: Feature[]
  onFeatureConfigChange: (featureId: string, config: Partial<FeatureConfig>) => void
  onAddFeature: (feature: Omit<Feature, "id" | "usage" | "config">) => void
  onGenerateInvoice: () => void
}

function DashboardPanel({
  features,
  onFeatureConfigChange,
  onAddFeature,
  onGenerateInvoice,
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

  return (
    <div className="flex h-full flex-col rounded-lg border border-background-border bg-background-base p-4">
      <div className="mb-1 flex shrink-0 items-baseline justify-between gap-4 border-background-line border-b pb-2.5">
        <span className="font-mono text-[10px] text-background-textContrast uppercase tracking-widest">
          Plan guardrails
        </span>
        <Button onClick={() => setIsAdding(!isAdding)} variant="link" size="sm">
          {isAdding ? (
            <>
              <X className="mr-1.5 size-3.5" />
              <span className="font-mono">Cancel</span>
            </>
          ) : (
            <>
              <Plus className="mr-1.5 size-3.5" />
              <span className="font-mono">Add feature</span>
            </>
          )}
        </Button>
      </div>
      <p className="mb-3 font-mono text-[10px] text-background-text">
        hard denies with 429 · soft allows and warns
      </p>

      {/* Main Content Area: Scrollable features */}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
        {isAdding && (
          <div className="mb-3 space-y-2 border-background-line border-b pb-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="new-feature-name"
                  className="font-mono text-[9px] text-background-text uppercase tracking-widest"
                >
                  Name
                </Label>
                <Input
                  id="new-feature-name"
                  placeholder="e.g. storage"
                  className="h-7 px-2 text-xs"
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
                <Label
                  htmlFor="new-feature-type"
                  className="font-mono text-[9px] text-background-text uppercase tracking-widest"
                >
                  Type
                </Label>
                <Select
                  value={newFeature.type}
                  onValueChange={(value) =>
                    setNewFeature({ ...newFeature, type: value as FeatureType })
                  }
                >
                  <SelectTrigger id="new-feature-type" className="h-7 px-2 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usage">Usage</SelectItem>
                    <SelectItem value="flat">Flat</SelectItem>
                    <SelectItem value="tiered">Tiered</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="new-feature-rate"
                  className="font-mono text-[9px] text-background-text uppercase tracking-widest"
                >
                  Rate ($)
                </Label>
                <Input
                  id="new-feature-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className="h-7 px-2 font-mono text-xs"
                  value={newFeature.rate}
                  onChange={(e) =>
                    setNewFeature({ ...newFeature, rate: Number.parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="new-feature-unit"
                  className="font-mono text-[9px] text-background-text uppercase tracking-widest"
                >
                  Unit
                </Label>
                <Input
                  id="new-feature-unit"
                  placeholder="e.g. GB"
                  className="h-7 px-2 text-xs"
                  value={newFeature.unit}
                  onChange={(e) => setNewFeature({ ...newFeature, unit: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
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
              >
                Add feature
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col">
          {features.map((feature) => (
            <div
              key={feature.id}
              className="flex items-center gap-2 border-background-line border-b py-2 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate text-background-textContrast text-xs">
                {feature.displayName}
              </span>

              <fieldset className="flex shrink-0 items-center rounded-sm border border-background-border p-px">
                <legend className="sr-only">{`${feature.displayName} limit type`}</legend>
                {(["hard", "soft"] as const).map((limitType) => (
                  <button
                    key={limitType}
                    type="button"
                    onClick={() => onFeatureConfigChange(feature.id, { limitType })}
                    aria-pressed={feature.config.limitType === limitType}
                    className={cn(
                      "rounded-[3px] px-1.5 py-0.5 font-mono text-[10px] transition-colors",
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
                value={feature.config.limit}
                onChange={(e) => {
                  const val = Number.parseFloat(e.target.value)
                  if (!Number.isNaN(val) && val >= 0) {
                    onFeatureConfigChange(feature.id, { limit: val })
                  }
                }}
                min="0"
                step="1"
                disabled={feature.isBase}
                aria-label={`${feature.displayName} limit`}
                className="h-7 w-14 shrink-0 px-1.5 text-right font-mono text-[11px] text-background-textContrast"
              />
              <span className="w-14 shrink-0 truncate font-mono text-[10px] text-background-text">
                {feature.unit}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Bill Customer Button - Sticky at bottom */}
      <div className="mt-auto shrink-0 pt-4">
        <Button
          type="button"
          variant="primary"
          size={"sm"}
          onClick={onGenerateInvoice}
          className="w-36"
        >
          Preview invoice evidence
        </Button>
      </div>
    </div>
  )
}

// ============================================
// DECISION PANEL (curated response + invoice evidence)
// ============================================

interface LiveResponseProps {
  features: Feature[]
  activeFeatureId: string | null
  discountActive: boolean
  discountPercentage: number
  limitedFeature: Feature | null
  flashError: boolean
}

// ============================================
// INVOICE PANEL (Visual representation of a bill)
// ============================================

interface InvoicePanelProps {
  features: Feature[]
  discountActive: boolean
  discountPercentage: number
}

function InvoicePanel({ features, discountActive, discountPercentage }: InvoicePanelProps) {
  const totalBill = features.reduce(
    (sum, f) => sum + calculateFeatureCost(f, discountActive, discountPercentage),
    0
  )

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
            <div className="flex size-6 items-center justify-center rounded border border-primary-border bg-primary-bg">
              <Receipt className="size-3.5 text-primary-text" aria-hidden />
            </div>
            <span className="font-bold text-background-textContrast text-sm uppercase tracking-tight">
              Invoice
            </span>
          </div>
          <p className="font-mono text-[10px] text-background-text">INV-2024-001</p>
        </div>
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
            <span className="text-background-text">Volume discount ({discountPercentage}%)</span>
            <span className="text-background-text">
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
        <div className="rounded border border-success-border bg-success-bg p-2 text-center">
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
}

function PricingPanel({ features }: PricingPanelProps) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-background-border bg-background-base p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <Badge variant="primary" className="text-[10px] uppercase tracking-wider">
          Pro Plan
        </Badge>
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
            <Check className="mt-0.5 size-3.5 shrink-0 text-background-text" aria-hidden />
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

      <Button type="button" variant="primary" className="w-full">
        Start with one paid action
      </Button>

      <p className="mt-3 text-center font-mono text-[9px] text-background-text">
        Sandbox first; connect your own Stripe when the path is proven.
      </p>
    </div>
  )
}

function LiveResponse({
  features,
  activeFeatureId,
  discountActive,
  discountPercentage,
  limitedFeature,
  flashError,
}: LiveResponseProps) {
  const activeFeature = features.find((f) => f.id === activeFeatureId)
  const limitedFeatureState = limitedFeature
    ? (features.find((feature) => feature.id === limitedFeature.id) ?? limitedFeature)
    : null
  const inspectedFeature = limitedFeatureState ?? activeFeature

  const isDenied = limitedFeatureState?.config.limitType === "hard"
  const isWarning = limitedFeatureState?.config.limitType === "soft"
  const remaining = inspectedFeature ? getRemainingUsage(inspectedFeature) : 0
  const runtimeCall = inspectedFeature ? getRuntimeCall(inspectedFeature) : null
  const decision = isDenied ? "deny" : inspectedFeature ? "allow" : "waiting"
  const decisionTitle = isDenied
    ? "Denied before work runs."
    : isWarning
      ? "Allowed with a spend warning."
      : inspectedFeature
        ? "Allowed before work runs."
        : "Click a paid action to see the decision."
  const decisionBody = isDenied
    ? `The next ${inspectedFeature?.displayName ?? "request"} would exceed the customer's hard guardrail. No work runs, and no rejected usage is added to the invoice.`
    : isWarning
      ? "The request crossed a soft guardrail. Unprice keeps it allowed, marks the threshold, and preserves invoice evidence for review."
      : inspectedFeature
        ? `${inspectedFeature.displayName} is inside ${DEMO_CUSTOMER}'s plan guardrail. The same money path can explain the invoice line later.`
        : "This demo is not showing every API field. It shows the commercial answer a request path needs before cost is created."
  const evidenceTrail = inspectedFeature ? getEvidenceTrail(inspectedFeature) : []

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-lg border bg-background-base p-4 text-xs transition-all duration-150",
        isDenied
          ? flashError
            ? "border-danger-solid bg-danger-bgActive"
            : "border-danger-border"
          : isWarning
            ? flashError
              ? "border-warning-solid bg-warning-bgActive"
              : "border-warning-border"
            : "border-background-border"
      )}
    >
      <div className="mb-4 flex items-start justify-between border-background-line border-b pb-3">
        <div className="flex items-center justify-center gap-2">
          <span className="font-mono text-[10px] text-background-text uppercase tracking-wider">
            Decision trail
          </span>
          <span
            className={cn(
              "w-fit rounded border px-2 py-0.5 font-mono font-semibold text-[10px] uppercase",
              isDenied
                ? "border-danger-border bg-danger-bg text-danger-text"
                : isWarning
                  ? "border-warning-border bg-warning-bg text-warning-text"
                  : inspectedFeature
                    ? "border-success-border bg-success-bg text-success-text"
                    : "border-background-border bg-background-bgSubtle text-background-text"
            )}
          >
            {decision}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex gap-3">
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
              isDenied
                ? "bg-danger-solid text-danger-foreground"
                : isWarning
                  ? "bg-warning-solid text-warning-foreground"
                  : inspectedFeature
                    ? "bg-success-solid text-success-foreground"
                    : "bg-background-bgHover text-background-textContrast"
            )}
          >
            {isDenied ? (
              <Ban className="size-4" aria-hidden />
            ) : inspectedFeature ? (
              <CheckCircle2 className="size-4" aria-hidden />
            ) : (
              <ShieldCheck className="size-4" aria-hidden />
            )}
          </span>
          <div>
            <h3 className="font-semibold text-background-textContrast text-base leading-6">
              {decisionTitle}
            </h3>
            <p className="mt-1 text-background-text text-sm leading-6">{decisionBody}</p>
          </div>
        </div>

        {inspectedFeature ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-background-border bg-background-bgSubtle p-3">
                <p className="font-mono text-[9px] text-background-text uppercase">Call</p>
                <p className="mt-1 break-words font-mono text-[11px] text-background-textContrast">
                  {runtimeCall}
                </p>
              </div>
              <div className="rounded-md border border-background-border bg-background-bgSubtle p-3">
                <p className="font-mono text-[9px] text-background-text uppercase">Remaining</p>
                <p className="mt-1 font-mono text-[11px] text-background-textContrast">
                  <AnimatedCounter value={remaining} /> {inspectedFeature.unit}
                </p>
              </div>
              <div className="rounded-md border border-background-border bg-background-bgSubtle p-3">
                <p className="font-mono text-[9px] text-background-text uppercase">Invoice</p>
                <p className="mt-1 font-mono text-[11px] text-background-textContrast">
                  {isDenied ? "no charge" : "evidence ready"}
                </p>
              </div>
            </div>

            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto rounded-md border border-background-border bg-background-bgSubtle p-3">
              <p className="font-mono text-[10px] text-background-text uppercase tracking-wider">
                Evidence kept with the decision
              </p>
              <div className="mt-3 space-y-2">
                {evidenceTrail.map((item) => (
                  <div key={item.label} className="flex items-start justify-between gap-4">
                    <span className="text-background-text text-xs">{item.label}</span>
                    <span className="max-w-[12rem] text-right font-mono text-[11px] text-background-textContrast">
                      {item.value}
                    </span>
                  </div>
                ))}
                <div className="flex items-start justify-between gap-4 border-background-line border-t pt-2">
                  <span className="text-background-text text-xs">Estimated accepted charge</span>
                  <span className="font-mono text-[11px] text-background-textContrast">
                    $
                    <AnimatedCounter
                      value={
                        isDenied
                          ? 0
                          : calculateFeatureCost(
                              inspectedFeature,
                              discountActive,
                              discountPercentage
                            )
                      }
                      decimals={2}
                    />
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-md border border-background-border bg-background-base p-3 font-mono text-[11px] text-background-text leading-5">
              <span className="text-background-textContrast">decision</span>
              {` = ${decision}`}
              <br />
              <span className="text-background-textContrast">reason</span>
              {` = ${isDenied ? "LIMIT_EXCEEDED" : isWarning ? "SOFT_LIMIT_REACHED" : "within_budget"}`}
              <br />
              <span className="text-background-textContrast">next</span>
              {` = ${isDenied ? "do not run work" : "run work, keep evidence"}`}
            </div>
          </>
        ) : (
          <div className="grid gap-3">
            {[
              "Resolve the customer's plan version.",
              "Check entitlement, budget, credits, and meter rule.",
              "Allow, warn, or deny before the paid work creates cost.",
            ].map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-md border border-background-border bg-background-bgSubtle p-3"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-background-text" aria-hidden />
                <p className="text-background-text text-sm leading-6">{item}</p>
              </div>
            ))}
          </div>
        )}
      </div>
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
}

function FeatureRow({ feature, onClick, isPressed, isActive, isLimited }: FeatureRowProps) {
  const spendProgress = (feature.usage / feature.config.limit) * 100

  return (
    <button
      type="button"
      onClick={(e) => onClick(e, feature.id)}
      disabled={isLimited && feature.config.limitType === "hard"}
      className={cn(
        "flex w-full items-center justify-between rounded-lg px-3 py-2 transition-all duration-150",
        "border border-background-border bg-background-base",
        focusRing,
        !feature.isBase &&
          "hover:border-background-borderHover hover:bg-background-bgHover active:scale-[0.98]",
        feature.isBase && "cursor-default",
        isActive && "border-info-border bg-background-bgHover",
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
              ? "border-background-border bg-background-bgSubtle text-background-text"
              : isLimited && feature.config.limitType === "hard"
                ? "border-danger-border bg-danger-bg text-danger-text"
                : isLimited && feature.config.limitType === "soft"
                  ? "border-warning-border bg-warning-bg text-warning-text"
                  : isActive
                    ? "border-info-border bg-info-bg text-info-text"
                    : "border-background-border bg-background-bgSubtle text-background-text"
          )}
        >
          [{feature.tag}]
        </span>
        <div className="text-left">
          <div className="font-medium text-background-textContrast text-sm">
            {feature.displayName}
          </div>
          <div className="font-mono text-[10px] text-background-text">
            {feature.isBase ? (
              <span>Always included</span>
            ) : (
              <>
                {feature.type === "usage" && (
                  <>
                    <span className="text-background-text">${feature.rate.toFixed(2)}</span>
                    <span className="text-background-text">/{feature.unit}</span>
                  </>
                )}
                {feature.type === "flat" && (
                  <span className="text-background-text">${feature.rate.toFixed(2)} fixed</span>
                )}
                {feature.type === "tiered" && (
                  <span className="text-background-text">Tiered pricing</span>
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
                      : "bg-background-borderHover"
                )}
                style={{ width: `${Math.min(spendProgress, 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="flex items-baseline justify-end gap-1">
          <span className="font-mono font-semibold text-background-textContrast text-base tabular-nums">
            {feature.isBase ? (
              <span>
                $<AnimatedCounter value={feature.rate} decimals={2} />
              </span>
            ) : (
              <AnimatedCounter value={feature.usage} />
            )}
          </span>
          <span className="font-mono text-[10px] text-background-text">
            {feature.isBase ? "/mo" : feature.unit}
          </span>
        </div>
        <div
          className={cn(
            "min-h-[12px] font-mono text-[9px] transition-opacity",
            isLimited ? "opacity-100" : "opacity-0",
            feature.config.limitType === "hard" ? "text-danger-text" : "text-warning-text"
          )}
        >
          {feature.config.limitType === "hard" ? (
            <span className="flex items-center justify-end gap-1">
              <Lock className="size-3" />
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
  headline = "Watch paid work stop before it creates cost.",
  description = "Click a paid action against the plan. The model shows the allow/deny decision, remaining budget, and invoice evidence from the same money path.",
  docsLinkText = "Read the Docs",
  discountThreshold = 10,
  discountPercentage = 20,
  className,
}: PricingHeroProps) {
  const [features, setFeatures] = useState<Feature[]>(DEFAULT_FEATURES)
  const [totalClicks, setTotalClicks] = useState(0)
  const [particles, setParticles] = useState<Particle[]>([])
  const [pressedFeature, setPressedFeature] = useState<string | null>(null)
  const [activeFeature, setActiveFeature] = useState<string | null>(null)
  const [limitedFeatures, setLimitedFeatures] = useState<Set<string>>(new Set())
  const [currentLimitedFeature, setCurrentLimitedFeature] = useState<Feature | null>(null)
  const [shake, setShake] = useState(false)
  const [flashError, setFlashError] = useState(false)
  const [activePanel, setActivePanel] = useState<ActivePanel>("response")
  const containerRef = useRef<HTMLDivElement>(null)
  const responseRef = useRef<HTMLDivElement>(null)
  const particleId = useRef(0)

  const discountActive = totalClicks >= discountThreshold
  const currentSpend = features.reduce(
    (sum, f) => sum + calculateFeatureCost(f, discountActive, discountPercentage),
    0
  )

  const anyLimited = limitedFeatures.size > 0
  const dynamicHeadline = anyLimited
    ? currentLimitedFeature?.config.limitType === "hard"
      ? "The request is blocked before work runs."
      : "The spend warning appears before invoice time."
    : headline
  const dynamicDescription = anyLimited
    ? currentLimitedFeature?.config.limitType === "hard"
      ? `The hard guardrail stopped ${currentLimitedFeature.displayName} at ${currentLimitedFeature.config.limit} ${currentLimitedFeature.unit}.`
      : `The soft guardrail flagged ${currentLimitedFeature?.displayName} at ${currentLimitedFeature?.config.limit} ${currentLimitedFeature?.unit}.`
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
        setShake(true)
        // Close guardrail editing and force open the decision trail when a limit is reached.
        setActivePanel("response")
        // On stacked (mobile) layouts the decision panel sits below the card;
        // bring the deny/warn moment into view when a guardrail fires.
        requestAnimationFrame(() => {
          const panel = responseRef.current
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

  return (
    <m.section
      variants={heroImageVariants}
      initial="hidden"
      animate="visible"
      className={cn(
        "mx-auto my-24 flex w-full max-w-6xl items-center justify-center px-6",
        className
      )}
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
          <Button
            variant="link"
            size="sm"
            asChild
            className="group h-auto gap-1.5 p-0 font-mono text-background-text text-xs"
          >
            <a href="https://docs.unprice.dev" target="_blank" rel="noreferrer">
              {docsLinkText}
              <ArrowRight
                className="size-3 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </a>
          </Button>
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
            <div className="border-background-border border-b px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-background-textContrast text-base">Pro Plan</h2>
                  <p className="font-mono text-[10px] text-background-text">Usage-based billing</p>
                </div>
                {discountActive && (
                  <Badge variant="primary" className="text-[10px]">
                    {discountPercentage}% volume pricing
                  </Badge>
                )}
              </div>
            </div>

            {/* Features List */}
            <div className="custom-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
              {features.map((feature) => (
                <FeatureRow
                  key={feature.id}
                  feature={feature}
                  onClick={handleFeatureClick}
                  isPressed={pressedFeature === feature.id}
                  isActive={activeFeature === feature.id}
                  isLimited={limitedFeatures.has(feature.id)}
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
                  "flex justify-center gap-2 border-t p-3",
                  currentLimitedFeature?.config.limitType === "hard"
                    ? "border-danger-border"
                    : "border-warning-border",
                  shake && "animate-shake"
                )}
              >
                <Button type="button" variant="primary" size="sm" onClick={handleIncreaseLimit}>
                  <ChevronUp className="mr-1.5 size-3.5" aria-hidden />
                  Increase limit
                </Button>
                <Button type="button" variant="default" size="sm" onClick={handleReset}>
                  <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
                  Reset
                </Button>
              </div>
            </div>

            {/* Total Summary */}
            <div className="border-background-border border-t px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-background-textContrast text-sm">
                    Accepted spend
                  </h3>
                  <p className="font-mono text-[10px] text-background-text">
                    {totalClicks} paid actions accepted
                  </p>
                </div>
                <div className="text-right font-bold font-mono text-background-textContrast text-xl tabular-nums">
                  <AnimatedCounter value={currentSpend} prefix="$" decimals={2} />
                </div>
              </div>

              {/* Volume pricing countdown; once active, the plan-header badge carries the state */}
              {!discountActive && (
                <p className="mt-1 font-mono text-[10px] text-background-text">
                  {Math.max(0, discountThreshold - totalClicks)} accepted actions until volume
                  pricing
                </p>
              )}
            </div>

            {/* Footer with panel switcher */}
            <div className="flex shrink-0 items-center justify-center gap-2 border-background-border border-t p-2">
              {PANEL_VIEWS.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setActivePanel(id)}
                  aria-label={`Show ${label}`}
                  aria-pressed={activePanel === id}
                  className={cn(
                    "text-background-text",
                    activePanel === id && "bg-background-bgActive text-background-textContrast"
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </Button>
              ))}
            </div>
          </div>

          {/* Side Panel (Dashboard or Response) - Right on desktop, below on mobile */}
          <div ref={responseRef} className="flex-1 scroll-mt-20 transition-all duration-300">
            {activePanel === "dashboard" && (
              <DashboardPanel
                features={features}
                onFeatureConfigChange={handleFeatureConfigChange}
                onAddFeature={handleAddFeature}
                onGenerateInvoice={handleGenerateInvoice}
              />
            )}
            {activePanel === "response" && (
              <LiveResponse
                features={features}
                activeFeatureId={activeFeature}
                discountActive={discountActive}
                discountPercentage={discountPercentage}
                limitedFeature={currentLimitedFeature}
                flashError={flashError}
              />
            )}
            {activePanel === "invoice" && (
              <InvoicePanel
                features={features}
                discountActive={discountActive}
                discountPercentage={discountPercentage}
              />
            )}
            {activePanel === "pricing" && <PricingPanel features={features} />}
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
        @media (prefers-reduced-motion: reduce) {
          :global(.animate-particle) {
            animation: none;
            opacity: 0;
          }
          :global(.animate-shake) {
            animation: none;
          }
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
