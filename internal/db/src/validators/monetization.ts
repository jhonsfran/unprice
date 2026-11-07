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
 * | rate card rows (ADR-0008 D2)        | `config.price`, `tiers`    | `featureRowDraft()` in apply     |
 *
 * A plan feature stores no price: `config.price` and `config.tiers` become rows
 * of the rate card `apply` assigns to the version, and `get` reads them back
 * from that card. Every object is `.strict()`, so the internal forms (row ids,
 * project ids) are rejected instead of silently ignored. Pricing-mode
 * semantics (which config fields each featureType needs, tier consecutiveness,
 * "price required for unit mode", the meterConfig/usage pairing) are not
 * restated: the boundary validates every priced feature against
 * `planVersionFeatureInsertBaseSchema` itself, so a malformed shape fails here
 * rather than several steps later inside the server.
 */
import { formatAmount, parseAmount } from "@unprice/money"
import * as z from "zod"

import { sha256HexSync } from "../utils/sha256-sync"
import { eventInsertBaseSchema } from "./events"
import { featureInsertBaseSchema } from "./features"
import {
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageFieldsSchema,
  configUsageSchema,
  planVersionFeatureInsertBaseSchema,
  priceSchema,
} from "./planVersionFeatures"
import { versionInsertBaseSchema } from "./planVersions"
import { planInsertBaseSchema } from "./plans"
import {
  USAGE_LIMIT_RESET_MESSAGE,
  billingIntervalCountSchema,
  billingIntervalSchema,
  isUsageLimitResetSupported,
  meterConfigSchema,
  typeFeatureSchema,
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

/**
 * Reset cadence for a usage feature. Omitting it means the billing cadence, and
 * `computeConfigHash` normalizes the two spellings to the same value.
 */
export const monetizationResetConfigSchema = z
  .object({
    interval: billingIntervalSchema.describe("Reset interval. Example: 'day'"),
    // `.default(1)` rather than `.optional()`: the default has to be materialized
    // into parse output, or an omitted count and an explicit 1 are the same
    // cadence with two different hashes.
    intervalCount: billingIntervalCountSchema
      .default(1)
      .describe("Number of intervals per reset window. Defaults to 1"),
  })
  .strict()
  .describe("When usage counters reset. Omit to reset on the billing cadence")

/**
 * A boundary price in canonical form ("0.10" and "0.1" are one price), because the rate card
 * stores amounts and `monetization.get` reads them back canonically; both must hash the same.
 */
const boundaryPriceSchema = priceSchema.transform((value) => {
  const parsed = parseAmount(value)
  return parsed.ok ? formatAmount(parsed.amount) : value
})

/**
 * One graduated tier as decimal strings. Tiers start at unit 1, follow each other without gaps,
 * and the last one is unbounded, so they map one to one onto a rate card graduated row.
 */
export const monetizationTierSchema = z
  .object({
    firstUnit: z.coerce
      .number()
      .int()
      .min(1)
      .describe("The first unit of this tier, inclusive. 1 for the first tier"),
    lastUnit: z.coerce
      .number()
      .int()
      .min(1)
      .nullable()
      .describe("The last unit of this tier, inclusive; null for the last tier"),
    unitPrice: boundaryPriceSchema.describe("Price per unit inside this tier, as a decimal string"),
    flatPrice: boundaryPriceSchema.describe(
      "Fixed price for entering this tier, as a decimal string"
    ),
  })
  .strict()

/**
 * Pricing configuration with decimal-string prices.
 *
 * `usageMode` and `units` come from `configUsageSchema` and are stored on the
 * plan feature. `price` and `tiers` are the feature's rate card row. `usageMode`
 * is relaxed to optional because it is required for usage features only; which
 * fields a featureType requires is decided by `validateAgainstInternalFeature`
 * below. A union would type better but report every failure once per branch.
 */
export const monetizationPriceConfigSchema = z
  .object(configUsageFieldsSchema.shape)
  .extend({
    price: boundaryPriceSchema
      .optional()
      .describe("Price as a decimal string. Example: '0.000002'"),
    tiers: z.array(monetizationTierSchema).optional().describe("Pricing tiers, decimal strings"),
  })
  .partial({ usageMode: true })
  .strict()
  .describe(
    "Pricing configuration. Prices are decimal strings and become rows of the plan version's rate card"
  )

/**
 * `meterConfigSchema` with `eventId` removed: the boundary points at an event by
 * slug and the server resolves it once the events exist.
 *
 * `groupBy` is preserved because it defines the rate card's active price dimensions.
 *
 * `.omit()` drops the shared schema's refinement, but nothing is restated to
 * compensate: `validateAgainstInternalFeature` sends the meter back through
 * `meterConfigSchema` with its refinement intact, which is what enforces
 * "aggregationField is required unless the method is count".
 */
export const monetizationMeterConfigSchema = z
  .object(meterConfigSchema.shape)
  .omit({ eventId: true })
  .strict()
  .describe("How usage is measured from a declared event")

const monetizationVersionFeatureBaseSchema = z
  .object({
    featureSlug: featureInsertBaseSchema.shape.slug.describe(
      "Slug of a feature declared in this document"
    ),
    featureType: typeFeatureSchema.describe("'flat', 'tier', 'package', or 'usage'"),
    config: monetizationPriceConfigSchema,
    meterConfig: monetizationMeterConfigSchema.optional(),
    // Mirrors `planVersionFeatureInsertBaseSchema.limit`, which cannot be read
    // off `.shape` because that schema is a `ZodEffects`. A zero allowance is a
    // valid configuration internally, so the boundary must not reject it.
    //
    // Deliberately narrower than internal's `z.coerce.number().int()`, because
    // blanket coercion is a money-path hazard here and because two of the values
    // it would accept cannot survive a round trip.
    //
    // `null`: rejected. It is a natural way to hand-write "unlimited", but
    // `Number(null)` is 0, which would land as a zero allowance.
    //
    // `0`: rejected, and this is not the boundary being fussy. `plans/service.ts`
    // (~:2168) writes `limit === 0 ? null : limit`, and null means unlimited — so
    // a stored 0 reads back as unlimited, minting a fresh draft on every apply
    // and granting everything where the agent asked to grant nothing. That
    // coercion cannot be dropped either: the dashboard's limit field is a text
    // input whose "leave empty for unlimited" produces `""`, and it is what stops
    // every untouched field from becoming a total denial. A stored 0 has no
    // agreed meaning anyway — enforcement, rating, credit provisioning, and three
    // display sites all read it differently. Do not "fix" this back.
    //
    // `false`, `""`, `[]`, `" "` would all coerce to 0 as well, so the input is
    // an explicit accept-list rather than whatever `Number()` makes of it.
    // Unlimited has exactly one spelling — omit the field — because two spellings
    // would hash differently and break idempotency.
    limit: z
      .preprocess(
        (value, ctx) => {
          if (value === null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "limit must be omitted to mean unlimited, it cannot be null",
              fatal: true,
            })

            return z.NEVER
          }

          return value
        },
        z
          .union([z.number(), z.string().regex(/^\d+$/)])
          .pipe(z.coerce.number<string | number>().int().nonnegative())
          .refine((limit) => limit !== 0, {
            message:
              "limit cannot be 0: a zero allowance is stored as null, which means unlimited. Omit limit for unlimited, or leave the feature out of the plan to make it unavailable",
          })
          .optional()
      )
      .describe("Maximum usage per reset window. Omit for unlimited"),
    // Usage features only — `validateAgainstInternalFeature` rejects it on the
    // others, which the server would silently discard.
    resetConfig: monetizationResetConfigSchema.optional(),
  })
  .strict()

/**
 * Placeholders for the values the server resolves after validation. The internal
 * schema requires them but constrains none of them, so fixed values are enough
 * to reuse it as the boundary's pricing authority.
 */
const INTERNAL_PLACEHOLDER_ID = "boundary_placeholder"

const INTERNAL_PLACEHOLDER_BILLING_CONFIG = {
  name: "boundary_placeholder",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
} as const

/** How the rate card prices a feature: one decimal price, or graduated tiers. */
function pricingMode(
  feature: z.infer<typeof monetizationVersionFeatureBaseSchema>
): "price" | "tiers" | null {
  if (feature.featureType === "tier") return "tiers"
  if (feature.featureType !== "usage") return "price"
  if (!feature.config.usageMode) return null
  return feature.config.usageMode === "tier" ? "tiers" : "price"
}

/**
 * The pricing half of a feature: the rate card row `apply` writes. A tier mode needs tiers that
 * start at 1, follow each other, and end unbounded (a graduated row); every other mode needs one
 * price.
 */
function validatePricing(
  feature: z.infer<typeof monetizationVersionFeatureBaseSchema>,
  ctx: z.RefinementCtx
) {
  const mode = pricingMode(feature)
  if (mode === null) return
  const { price, tiers } = feature.config

  if (mode === "price") {
    if (price === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A ${featureScope(feature)} needs a price`,
        path: ["config", "price"],
      })
    }
    if (tiers !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"tiers" does not apply to a ${featureScope(feature)}`,
        path: ["config", "tiers"],
      })
    }
    return
  }

  if (price !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"price" does not apply to a ${featureScope(feature)}`,
      path: ["config", "price"],
    })
  }
  if (!tiers || tiers.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `A ${featureScope(feature)} needs tiers`,
      path: ["config", "tiers"],
    })
    return
  }

  tiers.forEach((tier, index) => {
    const previous = tiers[index - 1]
    const expectedFirst = previous ? (previous.lastUnit ?? 0) + 1 : 1
    if (tier.firstUnit !== expectedFirst) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          index === 0
            ? "The first tier starts at unit 1"
            : "Tiers need to be consecutive, without gaps or overlaps",
        path: ["config", "tiers", index, "firstUnit"],
      })
    }
    const last = index === tiers.length - 1
    if (last !== (tier.lastUnit === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: last
          ? "The last tier is unbounded: its lastUnit is null"
          : "Only the last tier can be unbounded",
        path: ["config", "tiers", index, "lastUnit"],
      })
    }
    if (tier.lastUnit !== null && tier.lastUnit < tier.firstUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A tier's lastUnit cannot be before its firstUnit",
        path: ["config", "tiers", index, "lastUnit"],
      })
    }
  })
}

/**
 * Which config schema each featureType uses. `validatePlanVersionFeatureMutation`
 * owns this mapping but is not exported. Only the mapping is repeated; every
 * structural rule stays inside the schemas named here.
 *
 * Needed because `planVersionFeatureInsertBaseSchema` parses `config` through the
 * `configFeatureSchema` union first, and a union failure aborts the object parse
 * with "Invalid input" before the schema's own superRefine can say which rule
 * broke. Checking the featureType's schema first turns that into the real
 * message.
 */
const INTERNAL_CONFIG_SCHEMAS: Record<z.infer<typeof typeFeatureSchema>, z.ZodTypeAny> = {
  flat: configFlatSchema,
  tier: configTierSchema,
  package: configPackageSchema,
  usage: configUsageSchema,
}

/** How a feature is described in "does not apply" errors. */
function featureScope(feature: z.infer<typeof monetizationVersionFeatureBaseSchema>): string {
  // Naming the usage mode matters: tiers do apply to usage features, just not in
  // unit mode, and "does not apply to a usage feature" would read as a lie.
  return feature.config.usageMode
    ? `${feature.featureType} feature in ${feature.config.usageMode} mode`
    : `${feature.featureType} feature`
}

/**
 * Checks the feature's rate card pricing, then runs the rest through the
 * featureType's own config schema and `planVersionFeatureInsertBaseSchema`, the
 * canonical owner of the feature-level contract. Between them they reject a usage
 * feature without a mode or a meterConfig and a flat feature carrying one — none
 * of which are restated here.
 *
 * Also rejects the fields the server would accept and then discard: a config key
 * the normalizer strips, and a `resetConfig` on a non-usage feature.
 */
function validateAgainstInternalFeature(
  feature: z.infer<typeof monetizationVersionFeatureBaseSchema>,
  ctx: z.RefinementCtx
) {
  // `resolveResetConfigForFeature` in `internal/services/src/plans/service.ts`
  // returns null for every non-usage feature, so a reset cadence written on one
  // is discarded — but not before it changes the hash and mints a draft version
  // that behaves identically to the one before it.
  if (feature.featureType !== "usage" && feature.resetConfig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"resetConfig" does not apply to a ${featureScope(feature)}`,
      path: ["resetConfig"],
    })
  }

  validatePricing(feature, ctx)

  const { price: _price, tiers: _tiers, ...internalConfig } = feature.config
  const configResult = INTERNAL_CONFIG_SCHEMAS[feature.featureType].safeParse(internalConfig)

  if (!configResult.success) {
    for (const issue of configResult.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: ["config", ...issue.path],
      })
    }
  }

  const result = planVersionFeatureInsertBaseSchema.safeParse({
    planVersionId: INTERNAL_PLACEHOLDER_ID,
    featureId: INTERNAL_PLACEHOLDER_ID,
    featureType: feature.featureType,
    // Omitted once it has already failed, so the union does not report a second,
    // vaguer issue for the same problem. `config` is optional internally.
    config: configResult.success ? internalConfig : undefined,
    order: 0,
    defaultQuantity: 1,
    limit: feature.limit,
    billingConfig: INTERNAL_PLACEHOLDER_BILLING_CONFIG,
    resetConfig: feature.resetConfig && {
      name: INTERNAL_PLACEHOLDER_BILLING_CONFIG.name,
      resetInterval: feature.resetConfig.interval,
      resetIntervalCount: feature.resetConfig.intervalCount,
      resetAnchor: INTERNAL_PLACEHOLDER_BILLING_CONFIG.billingAnchor,
      planType: INTERNAL_PLACEHOLDER_BILLING_CONFIG.planType,
    },
    meterConfig: feature.meterConfig && {
      ...feature.meterConfig,
      eventId: INTERNAL_PLACEHOLDER_ID,
    },
  })

  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      })
    }

    return
  }

  if (!configResult.success) return

  // `normalizePlanVersionFeatureMutation` strips the config fields that do not
  // apply to the featureType. Surfacing that as an error keeps the boundary
  // honest instead of silently dropping what the agent wrote, and the internal
  // normalizer stays the only definition of which fields apply.
  //
  // Deliberately stricter than internal, and not a bug: internal accepts and
  // silently strips these (a `tier` feature carrying `price` or `usageMode`, a
  // `flat` feature carrying `tiers`), while the boundary rejects them so the
  // agent learns its document does not mean what it wrote. Anything emitting
  // this document — `monetization.get` above all — must emit configs already
  // normalized for their featureType, or the round trip fails here.
  const applied = result.data.config ?? {}

  for (const [key, value] of Object.entries(internalConfig)) {
    if (value === undefined || key in applied) continue

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${key}" does not apply to a ${featureScope(feature)}`,
      path: ["config", key],
    })
  }
}

/** A feature priced inside a plan version, referenced by slug. */
export const monetizationVersionFeatureSchema = monetizationVersionFeatureBaseSchema.superRefine(
  validateAgainstInternalFeature
)

/** The desired plan version. Content-addressed by `computeConfigHash`. */
export const monetizationVersionSchema = z
  .object({
    currency: versionInsertBaseSchema.shape.currency,
    paymentProvider: versionInsertBaseSchema.shape.paymentProvider,
    // This is commercial policy, not a dashboard-only implementation detail:
    // it decides whether a customer may start on a plan without payment details.
    // Materializing the default keeps omitted and explicit `true` equivalent.
    paymentMethodRequired: versionInsertBaseSchema.shape.paymentMethodRequired
      .default(true)
      .describe(
        "Whether a customer must provide a payment method before starting this plan. Defaults to true"
      ),
    billingConfig: monetizationBillingConfigSchema,
    features: z.array(monetizationVersionFeatureSchema).min(1),
  })
  .strict()
  .superRefine((version, ctx) => {
    const billingConfig = {
      ...INTERNAL_PLACEHOLDER_BILLING_CONFIG,
      billingInterval: version.billingConfig.interval,
      billingIntervalCount: version.billingConfig.intervalCount,
    }
    for (const [index, feature] of version.features.entries()) {
      if (feature.featureType !== "usage" || feature.limit === undefined || feature.resetConfig)
        continue
      if (!isUsageLimitResetSupported(billingConfig)) {
        ctx.addIssue({
          code: "custom",
          message: USAGE_LIMIT_RESET_MESSAGE,
          path: ["features", index, "resetConfig"],
        })
      }
    }
  })

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

/**
 * The document's shape without the "at least one plan" rule. `apply` requires a
 * plan; `monetization.get` has to be able to answer "this project has none".
 * Both schemas below are built from this one object and share one refinement, so
 * a rule can never hold for the write path and quietly not for the read path.
 */
const monetizationConfigObjectSchema = z
  .object({
    events: z.array(monetizationEventSchema).default([]),
    features: z.array(monetizationFeatureSchema).default([]),
    plans: z.array(monetizationPlanSchema),
  })
  .strict()

/**
 * Every cross-plan rule the document has. Written once and attached to both
 * schemas: the read document previously restated the duplicate-slug checks and
 * silently dropped everything else this does.
 */
function refineMonetizationConfig(
  config: z.infer<typeof monetizationConfigObjectSchema>,
  ctx: z.RefinementCtx
) {
  {
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
    const meteredEvents = new Map<string, string>()

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

        if (!eventSlug) return

        if (!eventSlugs.has(eventSlug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Meter references event "${eventSlug}", which is not declared in this document's events`,
            path: [...featurePath, "meterConfig", "eventSlug"],
          })
        }

        // The integration contract reports one event per feature, so a feature
        // metering different events in different plans would tell the
        // application to send one of them and silently under-report the other.
        const meteredEvent = meteredEvents.get(feature.featureSlug)

        if (meteredEvent === undefined) {
          meteredEvents.set(feature.featureSlug, eventSlug)
          return
        }

        if (meteredEvent !== eventSlug) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Feature "${feature.featureSlug}" meters event "${meteredEvent}" in another plan; one feature must meter one event`,
            path: [...featurePath, "meterConfig", "eventSlug"],
          })
        }
      })
    })

    // Guarded on there being plans at all, so the same refinement serves the
    // read document. `monetizationConfigSchema` keeps `.min(1)`, so for it the
    // guard is always true and the rule is unchanged.
    if (config.plans.length > 0 && defaultPlans !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Exactly one plan must set defaultPlan: true, found ${defaultPlans}`,
        path: ["plans"],
      })
    }
  }
}

export const monetizationConfigSchema = monetizationConfigObjectSchema
  .extend({ plans: z.array(monetizationPlanSchema).min(1) })
  .superRefine(refineMonetizationConfig)
  .describe("The whole desired monetization configuration for a project")

/**
 * What `monetization.get` returns: `monetizationConfigSchema` with exactly one
 * rule relaxed, because a project with no plans is a normal answer to a read.
 * Every other rule is the same function object.
 */
export const monetizationConfigDocumentSchema = monetizationConfigObjectSchema
  .superRefine(refineMonetizationConfig)
  .describe(
    "A project's monetization configuration, in the shape monetization.apply accepts. Empty when the project has no plans"
  )

export type MonetizationEventConfig = z.infer<typeof monetizationEventSchema>
export type MonetizationFeatureConfig = z.infer<typeof monetizationFeatureSchema>
export type MonetizationPriceConfig = z.infer<typeof monetizationPriceConfigSchema>
export type MonetizationMeterConfig = z.infer<typeof monetizationMeterConfigSchema>
export type MonetizationVersionFeatureConfig = z.infer<typeof monetizationVersionFeatureSchema>
export type MonetizationVersionConfig = z.infer<typeof monetizationVersionSchema>
export type MonetizationPlanConfig = z.infer<typeof monetizationPlanSchema>
export type MonetizationConfig = z.infer<typeof monetizationConfigSchema>
export type MonetizationConfigDocument = z.infer<typeof monetizationConfigDocumentSchema>
/** What callers send. Arrays with defaults may be omitted. */
export type MonetizationConfigInput = z.input<typeof monetizationConfigSchema>

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

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
 * The reset cadence the server will actually store for a feature, mirroring
 * `resolveResetConfigForFeature` and `resetConfigFromBillingConfig` in
 * `internal/services/src/plans/service.ts`: only usage features get one, and an
 * omitted one is a copy of the billing cadence.
 *
 * Normalized here rather than with a Zod `.default()` because the value depends
 * on a sibling field. Without it, omitting `resetConfig` and writing out the
 * billing cadence are the same configuration with two different hashes, and
 * every regeneration that flips the spelling mints a spurious draft version.
 */
function effectiveResetConfig(
  feature: MonetizationVersionFeatureConfig,
  billingConfig: MonetizationVersionConfig["billingConfig"]
): MonetizationVersionFeatureConfig["resetConfig"] {
  if (feature.featureType !== "usage") return undefined

  return (
    feature.resetConfig ?? {
      interval: billingConfig.interval,
      intervalCount: billingConfig.intervalCount,
    }
  )
}

/**
 * Content address of a plan's desired version: every material version field
 * `monetizationVersionSchema` declares, with the features sorted by slug and
 * their reset cadence normalized to what the server will store.
 *
 * The version is spread rather than hand-listed. The one exception is the
 * default `paymentMethodRequired: true`: it is deliberately omitted so documents
 * written before that field existed retain their content address. A `false`
 * value is included because it changes who can subscribe to the plan.
 *
 * Hashes the boundary form (slugs and decimal strings), never resolved ids or
 * rate card rows, so the same document hashes identically in every project.
 * Plan `title`, `description`, and `defaultPlan` are excluded: they are mutable
 * plan-row fields and never justify a new plan version.
 *
 * MUST be called on `monetizationConfigSchema` output, never on a raw request
 * body. Several boundary fields coerce or default (`priceSchema` is
 * `z.coerce.string()`, `resetConfig.intervalCount` defaults to 1), so
 * `price: 2` and `price: "2"`, or an omitted and an explicit `intervalCount`,
 * are the same configuration but hash differently before parsing. Idempotency is
 * derived from this hash, so hashing unparsed input would create duplicate draft
 * versions for identical configurations.
 */
export function computeConfigHash(plan: MonetizationPlanConfig): string {
  const { paymentMethodRequired, ...version } = plan.version
  const { billingConfig } = plan.version

  return sha256HexSync(
    canonicalJson({
      ...version,
      ...(paymentMethodRequired ? {} : { paymentMethodRequired }),
      features: [...plan.version.features]
        .sort((left, right) => compareStrings(left.featureSlug, right.featureSlug))
        .map((feature) => ({
          ...feature,
          resetConfig: effectiveResetConfig(feature, billingConfig),
        })),
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

/**
 * Lower wins when one feature is classified differently by different plans. A
 * `Record` rather than an ordered array so a kind added to
 * `integrationFeatureKindSchema` without a rank here is a compile error: an
 * array lookup would miss it, and a missing `indexOf` returns -1, which would
 * silently outrank everything.
 */
const KIND_PRECEDENCE: Record<IntegrationFeatureKind, number> = {
  "run-budget": 0,
  "usage-gate": 1,
  "usage-evidence": 2,
  "flat-access": 3,
}

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

    return [
      {
        slug: declared.slug,
        // The integration has to satisfy the most demanding plan that prices it.
        // Reduced rather than searched so the result is total by construction —
        // a `find` would need a fallback branch that can never run.
        kind: occurrences
          .map(({ feature }) => classifyFeature(feature))
          .reduce((left, right) =>
            KIND_PRECEDENCE[left] <= KIND_PRECEDENCE[right] ? left : right
          ),
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
