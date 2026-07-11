import { Ban, Check, Flag, type LucideIcon } from "lucide-react"

// ============================================
// PLAN MODEL
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

export const DEMO_CUSTOMER = "acme-corp"
export const DEMO_PLAN_VERSION = "pro@v3"
export const BASE_FEE = 19

// Limits are demo-scale on purpose: the deny is reachable in a handful of
// clicks, the soft warning in four, and storage crosses a pricing tier on the
// way — the guardrails are the story, not the ceiling.
export const DEFAULT_FEATURES: Feature[] = [
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

export function tierFor(feature: Feature, usage: number): { index: number; rate: number } {
  if (!feature.tiers) return { index: 1, rate: feature.rate }
  let lastUpto = 0
  for (const [i, tier] of feature.tiers.entries()) {
    const upto = tier.upto === "unlimited" ? Number.POSITIVE_INFINITY : tier.upto
    if (usage > lastUpto && usage <= upto) return { index: i + 1, rate: tier.rate }
    lastUpto = upto
  }
  return { index: feature.tiers.length, rate: feature.rate }
}

export function featureCost(feature: Feature): number {
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
export function marginalCharge(feature: Feature, nextUsage: number): number {
  if (feature.type === "flat") return feature.usage === 0 ? feature.rate : 0
  if (feature.type === "tiered") return tierFor(feature, nextUsage).rate
  return feature.rate
}

export function pricingRuleLabel(feature: Feature): string {
  if (feature.type === "flat") return `$${feature.rate.toFixed(2)} flat`
  if (feature.type === "tiered") {
    const tier = tierFor(feature, Math.max(1, feature.usage))
    return tier.rate === 0
      ? `tier ${tier.index} · free`
      : `tier ${tier.index} · $${tier.rate.toFixed(2)} / ${feature.rateUnit}`
  }
  return `$${feature.rate.toFixed(2)} / ${feature.rateUnit}`
}

export function guardrailLabel(feature: Feature): string {
  if (feature.type === "flat") return `included · ${feature.config.limit} ${feature.unit}`
  return `${feature.config.limitType} · ${feature.config.limit} ${feature.unit}`
}

/** Derived, never stored: a row is blocked when its next request would cross a
 * hard guardrail, flagged when it already crossed a soft one. Editing the rule
 * re-derives both — raising a limit unblocks the row with no bookkeeping. */
export function rowStatus(feature: Feature): "blocked" | "flagged" | "open" {
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

export type DecisionKind = "allow" | "warn" | "deny"

export interface Decision {
  kind: DecisionKind
  featureId: string
  charge: number
  reason: string
  seq: number
}

export const DECISION_COPY: Record<
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

// One color+icon table per decision kind, replacing the repeated kind→color
// ternaries the outcome chip used to inline.
export const INTENT: Record<
  DecisionKind,
  { icon: LucideIcon; chipRest: string; chipHit: string; iconBox: string; codeText: string }
> = {
  allow: {
    icon: Check,
    chipRest: "border-success-border bg-success-bg",
    chipHit: "border-success-borderHover bg-success-bgActive",
    iconBox: "bg-success-solid text-success-foreground",
    codeText: "text-success-text",
  },
  warn: {
    icon: Flag,
    chipRest: "border-warning-border bg-warning-bg",
    chipHit: "border-warning-borderHover bg-warning-bgActive",
    iconBox: "bg-warning-solid text-warning-foreground",
    codeText: "text-warning-text",
  },
  deny: {
    icon: Ban,
    chipRest: "border-danger-border bg-danger-bg",
    chipHit: "border-danger-borderHover bg-danger-bgActive",
    iconBox: "bg-danger-solid text-danger-foreground",
    codeText: "text-danger-text",
  },
}
