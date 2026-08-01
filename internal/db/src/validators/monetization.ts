/**
 * Boundary contract for `monetization.apply` / `monetization.get`.
 *
 * This is the document a coding agent sends to describe how an application makes
 * money. It reuses the existing insert validators instead of restating the
 * pricing model, with exactly three substitutions:
 *
 * | Internal                            | Boundary                   | Resolved by                      |
 * | ----------------------------------- | -------------------------- | -------------------------------- |
 * | `meterConfig.eventId`               | `eventSlug`                | server, after events exist       |
 * | `planId` / `featureId`              | `planSlug` / `featureSlug` | server                           |
 * | `config.price`, `tiers[].unitPrice` | decimal string             | `toDineroPrice()` in materialize |
 *
 * Every object is `.strict()`, so the internal forms (row ids, project ids,
 * Dinero snapshots) are rejected instead of silently ignored. Pricing-mode
 * semantics (tier consecutiveness, "price required for unit mode", "meterConfig
 * only for usage features") stay owned by `planVersionFeatureInsertBaseSchema`,
 * which the server runs after it converts prices and resolves slugs.
 */
import * as z from "zod"

import { eventInsertBaseSchema } from "./events"
import { featureInsertBaseSchema } from "./features"
import { priceSchema, tiersSchema } from "./planVersionFeatures"
import { versionInsertBaseSchema } from "./planVersions"
import { planInsertBaseSchema } from "./plans"
import {
  billingIntervalCountSchema,
  billingIntervalSchema,
  meterConfigSchema,
  tierModeSchema,
  typeFeatureSchema,
  unitSchema,
  usageModeSchema,
} from "./shared"

/** Declared SDK event. `eventInsertBaseSchema` minus the row/project identifiers. */
export const monetizationEventSchema = z
  .object({
    slug: eventInsertBaseSchema.shape.slug,
    name: eventInsertBaseSchema.shape.name,
    availableProperties: eventInsertBaseSchema.shape.availableProperties,
  })
  .strict()
  .describe("An SDK event the application reports. Meters aggregate over these")

/** Declared feature. `featureInsertBaseSchema` minus the row/project identifiers. */
export const monetizationFeatureSchema = z
  .object({
    slug: featureInsertBaseSchema.shape.slug,
    title: featureInsertBaseSchema.shape.title,
    description: featureInsertBaseSchema.shape.description,
    unitOfMeasure: featureInsertBaseSchema.shape.unitOfMeasure,
  })
  .strict()
  .describe("A feature the application sells. Plan versions price it")

/** Billing cadence in the same shape the plan templates already use. */
export const monetizationBillingConfigSchema = z
  .object({
    name: z.string().min(1).describe("Human-readable cadence name. Example: 'monthly'"),
    interval: billingIntervalSchema.describe("Billing interval. Example: 'month'"),
    intervalCount: billingIntervalCountSchema.describe("Number of intervals per billing period"),
  })
  .strict()
  .describe(
    "Billing cadence for the plan version. The server derives billingAnchor and planType from it"
  )

/** Usage reset cadence. Defaults to the billing cadence when omitted. */
export const monetizationResetConfigSchema = z
  .object({
    interval: billingIntervalSchema.describe("Reset interval. Example: 'day'"),
    intervalCount: billingIntervalCountSchema
      .optional()
      .describe("Number of intervals per reset window. Defaults to 1"),
  })
  .strict()
  .describe("When usage counters reset. Omit to reset on the billing cadence")

/** `tiersSchema` with the two Dinero prices replaced by decimal strings. */
export const monetizationTierSchema = tiersSchema
  .extend({
    unitPrice: priceSchema.describe("Price per unit inside this tier, as a decimal string"),
    flatPrice: priceSchema.describe("Fixed price for entering this tier, as a decimal string"),
  })
  .strict()

/**
 * Pricing configuration with decimal-string prices. The featureType decides
 * which fields apply; `planVersionFeatureInsertBaseSchema` enforces that after
 * the server converts the prices to Dinero snapshots.
 */
export const monetizationPriceConfigSchema = z
  .object({
    price: priceSchema.optional().describe("Price as a decimal string. Example: '0.000002'"),
    usageMode: usageModeSchema.optional().describe("Usage pricing mode for usage features"),
    tierMode: tierModeSchema.optional().describe("Tier calculation mode when usageMode is 'tier'"),
    tiers: z.array(monetizationTierSchema).optional().describe("Pricing tiers, decimal strings"),
    units: unitSchema.optional().describe("Units per package when usageMode is 'package'"),
  })
  .strict()
  .describe("Pricing configuration. Prices cross the boundary as decimal strings, never as Dinero")

/**
 * `meterConfigSchema` with `eventId` removed: the boundary points at an event by
 * slug and the server resolves it once the events exist. The aggregation rule is
 * repeated here because the shared schema is a `ZodEffects` and cannot be
 * `.omit()`-ed with its refinement intact.
 */
export const monetizationMeterConfigSchema = meterConfigSchema
  .innerType()
  .omit({ eventId: true })
  .strict()
  .superRefine((data, ctx) => {
    if (data.aggregationMethod !== "count" && !data.aggregationField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregationField is required unless the aggregation method is count",
        path: ["aggregationField"],
      })
    }
  })
  .describe("How usage is measured from a declared event")

/** A feature priced inside a plan version, referenced by slug. */
export const monetizationVersionFeatureSchema = z
  .object({
    featureSlug: featureInsertBaseSchema.shape.slug.describe(
      "Slug of a feature declared in this document"
    ),
    featureType: typeFeatureSchema.describe("'flat', 'tier', 'package', or 'usage'"),
    config: monetizationPriceConfigSchema,
    meterConfig: monetizationMeterConfigSchema.optional(),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum usage per reset window. Omit for unlimited"),
    resetConfig: monetizationResetConfigSchema.optional(),
  })
  .strict()

/** The desired plan version. Content-addressed by `computeConfigHash`. */
export const monetizationVersionSchema = z
  .object({
    currency: versionInsertBaseSchema.shape.currency,
    paymentProvider: versionInsertBaseSchema.shape.paymentProvider,
    billingConfig: monetizationBillingConfigSchema,
    features: z.array(monetizationVersionFeatureSchema).min(1),
  })
  .strict()

export const monetizationPlanSchema = z
  .object({
    slug: planInsertBaseSchema.shape.slug,
    title: planInsertBaseSchema.shape.title,
    description: planInsertBaseSchema.shape.description,
    defaultPlan: planInsertBaseSchema.shape.defaultPlan,
    version: monetizationVersionSchema,
  })
  .strict()

function collectDuplicates(slugs: readonly string[]): { index: number; slug: string }[] {
  const seen = new Set<string>()
  const duplicates: { index: number; slug: string }[] = []

  slugs.forEach((slug, index) => {
    if (seen.has(slug)) {
      duplicates.push({ index, slug })
      return
    }
    seen.add(slug)
  })

  return duplicates
}

export const monetizationConfigSchema = z
  .object({
    events: z.array(monetizationEventSchema).default([]),
    features: z.array(monetizationFeatureSchema).default([]),
    plans: z.array(monetizationPlanSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const eventSlugs = new Set(config.events.map((event) => event.slug))
    const featureSlugs = new Set(config.features.map((feature) => feature.slug))

    for (const [key, slugs] of [
      ["events", config.events.map((event) => event.slug)],
      ["features", config.features.map((feature) => feature.slug)],
      ["plans", config.plans.map((plan) => plan.slug)],
    ] as const) {
      for (const duplicate of collectDuplicates(slugs)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate slug "${duplicate.slug}" in ${key}`,
          path: [key, duplicate.index, "slug"],
        })
      }
    }

    let defaultPlans = 0

    config.plans.forEach((plan, planIndex) => {
      if (plan.defaultPlan) defaultPlans += 1

      const versionFeatureSlugs = plan.version.features.map((feature) => feature.featureSlug)

      for (const duplicate of collectDuplicates(versionFeatureSlugs)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Feature "${duplicate.slug}" is priced twice in plan "${plan.slug}"`,
          path: ["plans", planIndex, "version", "features", duplicate.index, "featureSlug"],
        })
      }

      plan.version.features.forEach((feature, featureIndex) => {
        const featurePath = ["plans", planIndex, "version", "features", featureIndex] as const

        if (!featureSlugs.has(feature.featureSlug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Feature "${feature.featureSlug}" is not declared in this document's features`,
            path: [...featurePath, "featureSlug"],
          })
        }

        const eventSlug = feature.meterConfig?.eventSlug

        if (eventSlug && !eventSlugs.has(eventSlug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Meter references event "${eventSlug}", which is not declared in this document's events`,
            path: [...featurePath, "meterConfig", "eventSlug"],
          })
        }
      })
    })

    if (defaultPlans !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Exactly one plan must set defaultPlan: true, found ${defaultPlans}`,
        path: ["plans"],
      })
    }
  })
  .describe("The whole desired monetization configuration for a project")

export type MonetizationEventConfig = z.infer<typeof monetizationEventSchema>
export type MonetizationFeatureConfig = z.infer<typeof monetizationFeatureSchema>
export type MonetizationPriceConfig = z.infer<typeof monetizationPriceConfigSchema>
export type MonetizationMeterConfig = z.infer<typeof monetizationMeterConfigSchema>
export type MonetizationVersionFeatureConfig = z.infer<typeof monetizationVersionFeatureSchema>
export type MonetizationVersionConfig = z.infer<typeof monetizationVersionSchema>
export type MonetizationPlanConfig = z.infer<typeof monetizationPlanSchema>
export type MonetizationConfig = z.infer<typeof monetizationConfigSchema>
/** What callers send. Arrays with defaults may be omitted. */
export type MonetizationConfigInput = z.input<typeof monetizationConfigSchema>

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

const SHA256_INITIAL_STATE = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_ROUND_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/**
 * Synchronous SHA-256 over the UTF-8 encoding of `message`, as lowercase hex.
 *
 * `crypto.subtle.digest` is async and `node:crypto` cannot be imported here:
 * `@unprice/db/validators` is bundled for Cloudflare Workers and for Next.js
 * client components. This implementation only uses `TextEncoder` and typed
 * arrays, so it runs unchanged in all three. Correctness is pinned by
 * known-answer vectors and a cross-check against `node:crypto` in the tests.
 */
export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message)
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const hash = Uint32Array.from(SHA256_INITIAL_STATE)
  const schedule = new Uint32Array(64)

  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(block + index * 4)
    }

    for (let index = 16; index < 64; index++) {
      const previous = schedule[index - 15]!
      const recent = schedule[index - 2]!
      const s0 = rotateRight32(previous, 7) ^ rotateRight32(previous, 18) ^ (previous >>> 3)
      const s1 = rotateRight32(recent, 17) ^ rotateRight32(recent, 19) ^ (recent >>> 10)
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0
    }

    let a = hash[0]!
    let b = hash[1]!
    let c = hash[2]!
    let d = hash[3]!
    let e = hash[4]!
    let f = hash[5]!
    let g = hash[6]!
    let h = hash[7]!

    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choose + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0
      const s0 = rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }

  let digest = ""

  for (const word of hash) {
    digest += word.toString(16).padStart(8, "0")
  }

  return digest
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** JSON with object keys sorted by code unit and `undefined` members dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null"

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(",")}}`
  }

  return JSON.stringify(value)
}

/**
 * Content address of a plan's desired version: currency, payment provider,
 * billing cadence, and the featureSlug-sorted feature list.
 *
 * Hashes the boundary form (slugs and decimal strings), never resolved ids or
 * Dinero snapshots, so the same document hashes identically in every project.
 * Plan `title`, `description`, and `defaultPlan` are excluded: they are mutable
 * plan-row fields and never justify a new plan version.
 */
export function computeConfigHash(plan: MonetizationPlanConfig): string {
  const { currency, paymentProvider, billingConfig, features } = plan.version

  return sha256Hex(
    canonicalJson({
      currency,
      paymentProvider,
      billingConfig,
      features: [...features].sort((left, right) =>
        compareStrings(left.featureSlug, right.featureSlug)
      ),
    })
  )
}

// ---------------------------------------------------------------------------
// Integration contract
// ---------------------------------------------------------------------------

export const integrationFeatureKindSchema = z
  .enum(["flat-access", "usage-gate", "usage-evidence", "run-budget"])
  .describe(
    "How the application integrates the feature: entitlement check only ('flat-access'), synchronous allowance check before the work ('usage-gate'), usage reported after the work ('usage-evidence'), or work executed inside a budgeted run ('run-budget')"
  )

export const integrationContractSchema = z
  .object({
    defaultPlan: z.object({
      slug: z.string(),
      planVersionId: z.string(),
      note: z.string(),
    }),
    events: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        requiredProperties: z
          .array(z.string())
          .describe("Numeric payload properties the application must send for the meters to work"),
      })
    ),
    features: z.array(
      z.object({
        slug: z.string(),
        kind: integrationFeatureKindSchema,
        eventSlug: z.string().nullable(),
        planSlugs: z.array(z.string()),
      })
    ),
    warnings: z.array(
      z.object({
        featureSlug: z.string(),
        code: z.literal("usage_unknown_before_work"),
        message: z.string(),
      })
    ),
  })
  .describe("What the application has to call at runtime for this configuration to work")

export type IntegrationFeatureKind = z.infer<typeof integrationFeatureKindSchema>
export type IntegrationContract = z.infer<typeof integrationContractSchema>

/** Plan slug to the plan version id the server created or reused for it. */
export type ResolvedPlanVersions = Readonly<Record<string, string>>

const DEFAULT_PLAN_NOTE =
  "Customers created with customers.signUp and no planSlug are assigned this plan"

const KIND_PRECEDENCE: readonly IntegrationFeatureKind[] = [
  "run-budget",
  "usage-gate",
  "usage-evidence",
  "flat-access",
]

/**
 * Usage is knowable before the work runs only when the meter counts events. Any
 * other aggregation measures a magnitude the application learns afterwards.
 */
function isKnowableBeforeWork(feature: MonetizationVersionFeatureConfig): boolean {
  return feature.meterConfig?.aggregationMethod === "count"
}

function classifyFeature(feature: MonetizationVersionFeatureConfig): IntegrationFeatureKind {
  if (feature.featureType !== "usage") return "flat-access"
  if (typeof feature.limit !== "number") return "usage-evidence"
  // A limit on a quantity that is unknown up front can only be enforced by
  // reserving a budget for the run and reconciling once the work is done.
  return isKnowableBeforeWork(feature) ? "usage-gate" : "run-budget"
}

/**
 * Pure projection of a validated configuration into the runtime calls the
 * application has to make. `resolvedPlanVersions` carries the plan-slug to
 * plan-version-id mapping the server computed while applying the document.
 */
export function buildIntegrationContract(
  config: MonetizationConfig,
  resolvedPlanVersions: ResolvedPlanVersions
): IntegrationContract {
  const defaultPlan = config.plans.find((plan) => plan.defaultPlan)

  if (!defaultPlan) {
    throw new Error("Monetization configuration has no default plan")
  }

  const defaultPlanVersionId = resolvedPlanVersions[defaultPlan.slug]

  if (!defaultPlanVersionId) {
    throw new Error(`No resolved plan version for plan "${defaultPlan.slug}"`)
  }

  const pricedFeatures = config.plans.flatMap((plan) =>
    plan.version.features.map((feature) => ({ planSlug: plan.slug, feature }))
  )

  const requiredProperties = new Map<string, Set<string>>()

  for (const { feature } of pricedFeatures) {
    const { eventSlug, aggregationField } = feature.meterConfig ?? {}
    if (!eventSlug) continue

    const properties = requiredProperties.get(eventSlug) ?? new Set<string>()
    if (aggregationField) properties.add(aggregationField)
    requiredProperties.set(eventSlug, properties)
  }

  const events = config.events.map((event) => ({
    slug: event.slug,
    name: event.name,
    requiredProperties: Array.from(requiredProperties.get(event.slug) ?? []).sort(compareStrings),
  }))

  const features = config.features.flatMap((declared) => {
    const occurrences = pricedFeatures.filter(
      ({ feature }) => feature.featureSlug === declared.slug
    )

    if (occurrences.length === 0) return []

    const kinds = new Set(occurrences.map(({ feature }) => classifyFeature(feature)))

    return [
      {
        slug: declared.slug,
        // The integration has to satisfy the most demanding plan that prices it.
        kind: KIND_PRECEDENCE.find((kind) => kinds.has(kind)) ?? "flat-access",
        eventSlug:
          occurrences.find(({ feature }) => feature.meterConfig)?.feature.meterConfig?.eventSlug ??
          null,
        planSlugs: occurrences.map(({ planSlug }) => planSlug),
      },
    ]
  })

  const warned = new Set<string>()
  const warnings: IntegrationContract["warnings"] = []

  for (const { feature } of pricedFeatures) {
    if (feature.featureType !== "usage") continue
    if (isKnowableBeforeWork(feature)) continue
    if (warned.has(feature.featureSlug)) continue

    warned.add(feature.featureSlug)
    warnings.push({
      featureSlug: feature.featureSlug,
      code: "usage_unknown_before_work",
      message: `Actual usage of "${feature.featureSlug}" is unknown before the work runs. Report it with usage.record after the work, or run the work inside a budgeted run, instead of guessing a quantity for usage.consume`,
    })
  }

  return {
    defaultPlan: {
      slug: defaultPlan.slug,
      planVersionId: defaultPlanVersionId,
      note: DEFAULT_PLAN_NOTE,
    },
    events,
    features,
    warnings,
  }
}
