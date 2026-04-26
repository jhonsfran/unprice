import type { OverageStrategy, PlanType } from "../validators/shared"

export const TIER_MODES_MAP = {
  volume: {
    label: "Volume",
    description: "All units are charged at the same price based on the total quantity",
  },
  graduated: {
    label: "Graduated",
    description: "Each tier has its own price — units in lower tiers stay at lower prices",
  },
} as const

export const FEATURE_TYPES_MAPS = {
  flat: {
    code: "flat",
    label: "Flat",
    description: "One fixed price — quantity is set when the customer subscribes",
  },
  tier: {
    code: "tier",
    label: "Tier",
    description: "Price varies by quantity — quantity is set when the customer subscribes",
  },
  package: {
    code: "package",
    label: "Package",
    description: "Price per bundle of units — quantity is set when the customer subscribes",
  },
  usage: {
    code: "usage",
    label: "Usage",
    description:
      "Price based on actual consumption — tracked automatically during the billing period",
  },
} as const

export const USAGE_MODES_MAP = {
  tier: {
    code: "tier",
    label: "Tier",
    description:
      "Price changes based on how much was consumed — higher usage may unlock better rates",
  },
  package: {
    code: "package",
    label: "Package",
    description: "Charged in bundles — e.g., every 100 API calls counts as one package",
  },
  unit: {
    code: "unit",
    label: "Unit",
    description: "Charged per individual unit consumed — e.g., per API call, per message sent",
  },
} as const

export const AGGREGATION_METHODS_MAP = {
  sum: {
    label: "Sum",
    description: "Total of all reported values within the billing period",
  },
  count: {
    label: "Count",
    description: "Number of events reported within the billing period",
  },
  max: {
    label: "Maximum",
    description: "Highest reported value within the billing period",
  },
  latest: {
    label: "Latest",
    description: "Most recent reported value within the billing period",
  },
} as const

export const BILLING_INTERVALS = ["month", "year", "week", "day", "minute", "onetime"] as const

export const BILLING_CONFIG: Record<
  string,
  {
    label: string
    description: string
    billingInterval: (typeof BILLING_INTERVALS)[number]
    billingIntervalCount: number
    billingAnchorOptions: (number | "dayOfCreation")[]
    dev?: boolean
    planType: PlanType
  }
> = {
  monthly: {
    label: "Monthly",
    description: "Billed monthly at the specified billing anchor",
    billingInterval: "month",
    billingIntervalCount: 1,
    billingAnchorOptions: ["dayOfCreation", ...Array.from({ length: 31 }, (_, i) => i + 1)],
    planType: "recurring",
  },
  yearly: {
    label: "Yearly",
    description: "Billed yearly at the specified billing anchor",
    billingInterval: "year",
    billingIntervalCount: 1,
    billingAnchorOptions: ["dayOfCreation", ...Array.from({ length: 12 }, (_, i) => i + 1)],
    planType: "recurring",
  },
  "every-5-minutes": {
    label: "Every 5 minutes",
    description: "Billed every 5 minutes",
    billingInterval: "minute",
    billingIntervalCount: 5,
    billingAnchorOptions: ["dayOfCreation"],
    dev: true,
    planType: "recurring",
  },
  "every-10-minutes": {
    label: "Every 10 minutes",
    description: "Billed every 10 minutes",
    billingInterval: "minute",
    billingIntervalCount: 10,
    billingAnchorOptions: ["dayOfCreation"],
    dev: true,
    planType: "recurring",
  },
  "every-15-minutes": {
    label: "Every 15 minutes",
    description: "Billed every 15 minutes",
    billingInterval: "minute",
    billingIntervalCount: 15,
    billingAnchorOptions: ["dayOfCreation"],
    dev: true,
    planType: "recurring",
  },
  onetime: {
    label: "Onetime",
    description: "Billed once",
    billingInterval: "onetime",
    billingIntervalCount: 1,
    billingAnchorOptions: ["dayOfCreation"],
    planType: "onetime",
  },
}

export const RESET_CONFIG: Record<
  string,
  {
    label: string
    description: string
    resetInterval: (typeof BILLING_INTERVALS)[number]
    resetIntervalCount: number
    resetAnchorOptions: (number | "dayOfCreation")[]
    dev?: boolean
    planType: PlanType
  }
> = {
  daily: {
    label: "Daily",
    description: "Reset daily at the specified reset anchor",
    resetInterval: "day",
    resetIntervalCount: 1,
    // Daily anchors are UTC hours (0-23).
    resetAnchorOptions: ["dayOfCreation", ...Array.from({ length: 24 }, (_, i) => i)],
    planType: "recurring",
  },
  monthly: {
    label: "Monthly",
    description: "Reset monthly at the specified reset anchor",
    resetInterval: "month",
    resetIntervalCount: 1,
    resetAnchorOptions: ["dayOfCreation", ...Array.from({ length: 12 }, (_, i) => i + 1)],
    planType: "recurring",
  },
  yearly: {
    label: "Yearly",
    description: "Reset yearly at the specified reset anchor",
    resetInterval: "year",
    resetIntervalCount: 1,
    resetAnchorOptions: ["dayOfCreation", ...Array.from({ length: 12 }, (_, i) => i + 1)],
    planType: "recurring",
  },
  "every-10-minutes": {
    label: "Every 10 minutes",
    description: "Reset every 10 minutes at the specified reset anchor",
    resetInterval: "minute",
    resetIntervalCount: 10,
    resetAnchorOptions: ["dayOfCreation"],
    dev: true,
    planType: "recurring",
  },
  "every-15-minutes": {
    label: "Every 15 minutes",
    description: "Reset every 15 minutes at the specified reset anchor",
    resetInterval: "minute",
    resetIntervalCount: 15,
    resetAnchorOptions: ["dayOfCreation"],
    dev: true,
    planType: "recurring",
  },
}

type AggregationMethod = keyof typeof AGGREGATION_METHODS_MAP
export type TierMode = keyof typeof TIER_MODES_MAP
export type UsageMode = keyof typeof USAGE_MODES_MAP
export type FeatureType = keyof typeof FEATURE_TYPES_MAPS

export const PAYMENT_PROVIDERS = ["stripe", "square", "sandbox"] as const
export const CURRENCIES = ["USD", "EUR"] as const
export const STAGES = ["prod", "test", "dev"] as const
export const STATUS_PLAN = ["draft", "published"] as const

// this status represents the status of the subscription, it would be the same for all phases
// but phases can have different statuses than the subscription is they are not active
// for instance a phase was changed to new plan, we create a new phase with status as active
// and we leave the old phase with status changed.
export const SUBSCRIPTION_STATUS = [
  "active", // the subscription is active
  "trialing", // the subscription is trialing
  "pending_payment", // pay-in-advance plan waiting on first payment webhook before becoming active
  "pending_activation", // wallet activation (period grants) failed at create or renew; retry sweeper re-attempts. Ingestion is blocked until grants are issued.
  "canceled", // the subscription is cancelled
  "expired", // the subscription has expired - no auto-renew
  "past_due", // the subscription is past due - payment pending
] as const

export const PLAN_TYPES = ["recurring", "onetime"] as const
export const ROLES_APP = ["OWNER", "ADMIN", "MEMBER"] as const
export const WHEN_TO_BILLING = ["pay_in_advance", "pay_in_arrear"] as const
export const ENTITLEMENT_MERGING_POLICY = ["sum", "max", "min", "replace"] as const
export const DUE_BEHAVIOUR = ["cancel", "downgrade"] as const
export const GRANT_TYPES = ["subscription", "manual", "promotion", "trial", "addon"] as const
export const SUBJECT_TYPES = ["project", "plan", "plan_version", "customer"] as const
export const INVOICE_STATUS = ["unpaid", "paid", "waiting", "void", "draft", "failed"] as const
export const FEATURE_CONFIG_TYPES = ["feature", "addon"] as const
export const COLLECTION_METHODS = ["charge_automatically", "send_invoice"] as const
export const BILLING_PERIOD_STATUS = ["pending", "invoiced", "voided"] as const
export const BILLING_PERIOD_TYPE = ["normal", "trial"] as const
export const OVERAGE_STRATEGIES = ["none", "last-call", "always"] as const
export const WALLET_TOPUP_STATUSES = ["pending", "completed", "failed", "expired"] as const
export const WALLET_GRANT_SOURCES = [
  "promo",
  "plan_included",
  "trial",
  "manual",
  "credit_line",
] as const

export const TIER_MODES = Object.keys(TIER_MODES_MAP) as unknown as readonly [
  TierMode,
  ...TierMode[],
]
export const USAGE_MODES = Object.keys(USAGE_MODES_MAP) as unknown as readonly [
  UsageMode,
  ...UsageMode[],
]
export const AGGREGATION_METHODS = Object.keys(AGGREGATION_METHODS_MAP) as unknown as readonly [
  AggregationMethod,
  ...AggregationMethod[],
]
export const FEATURE_TYPES = Object.keys(FEATURE_TYPES_MAPS) as unknown as readonly [
  FeatureType,
  ...FeatureType[],
]

export type Behavior = "sum" | "max" | "latest"

interface MethodConfig {
  behavior: Behavior
}

export const AGGREGATION_CONFIG: Record<AggregationMethod, MethodConfig> = {
  sum: { behavior: "sum" },
  count: { behavior: "sum" },
  max: { behavior: "max" },
  latest: { behavior: "latest" },
}

export const OVERAGE_STRATEGIES_MAP: Record<
  OverageStrategy,
  { label: string; description: string }
> = {
  none: {
    label: "None",
    description: "No overage strategy, strict hard limit",
  },
  "last-call": {
    label: "Last call",
    description: "Allow one final report as long as tokens were available.",
  },
  always: {
    label: "Always",
    description: "Always allow (soft limit/overage enabled)",
  },
}
