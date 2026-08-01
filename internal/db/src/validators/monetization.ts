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
 * semantics (which config fields each featureType needs, tier consecutiveness,
 * "price required for unit mode", the meterConfig/usage pairing) are not
 * restated: the boundary validates every priced feature against
 * `planVersionFeatureInsertBaseSchema` itself, so a malformed shape fails here
 * rather than several steps later inside the server.
 */
import * as z from "zod"

import { sha256HexSync } from "../utils/sha256-sync"
import { eventInsertBaseSchema } from "./events"
import { featureInsertBaseSchema } from "./features"
import {
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
  planVersionFeatureInsertBaseSchema,
  priceSchema,
  tiersSchema,
} from "./planVersionFeatures"
import { versionInsertBaseSchema } from "./planVersions"
import { planInsertBaseSchema } from "./plans"
import {
  billingIntervalCountSchema,
  billingIntervalSchema,
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

/** `tiersSchema` with the two Dinero prices replaced by decimal strings. */
export const monetizationTierSchema = tiersSchema
  .extend({
    unitPrice: priceSchema.describe("Price per unit inside this tier, as a decimal string"),
    flatPrice: priceSchema.describe("Fixed price for entering this tier, as a decimal string"),
  })
  .strict()

/**
 * Pricing configuration with decimal-string prices.
 *
 * The field model comes from `configUsageSchema`, whose shape is the superset of
 * all four internal config schemas (flat, tier, package, usage all use these same
 * five keys), with only the documented price substitution applied. `usageMode` is
 * relaxed to optional because it is required for usage features only; which
 * fields a given featureType actually requires is decided by the internal
 * schemas, through `validateAgainstInternalFeature` below. A union of the four
 * would type better but report every failure four times, once per branch.
 */
export const monetizationPriceConfigSchema = configUsageSchema
  .innerType()
  .extend({
    price: priceSchema.optional().describe("Price as a decimal string. Example: '0.000002'"),
    tiers: z.array(monetizationTierSchema).optional().describe("Pricing tiers, decimal strings"),
  })
  .partial({ usageMode: true })
  .strict()
  .describe("Pricing configuration. Prices cross the boundary as decimal strings, never as Dinero")

/**
 * `meterConfigSchema` with `eventId` removed: the boundary points at an event by
 * slug and the server resolves it once the events exist.
 *
 * `filters`, `groupBy`, and `windowSize` are removed too. They are marked
 * "TODO: implement this later" in `shared.ts` and nothing reads them, so at the
 * boundary they would be accepted, hashed into a new draft version, and change
 * no behaviour. Add them back here when they do something.
 *
 * `.omit()` drops the shared schema's refinement, but nothing is restated to
 * compensate: `validateAgainstInternalFeature` sends the meter back through
 * `meterConfigSchema` with its refinement intact, which is what enforces
 * "aggregationField is required unless the method is count".
 */
export const monetizationMeterConfigSchema = meterConfigSchema
  .innerType()
  .omit({ eventId: true, filters: true, groupBy: true, windowSize: true })
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
    // One deliberate divergence: internal is `z.coerce.number().int()`, and
    // blanket coercion is a money-path hazard here. `Number(null)`,
    // `Number(false)`, `Number("")`, and `Number([])` are all 0 — a zero
    // allowance that denies everything — and `limit: null` is a natural way to
    // hand-write "unlimited". So this takes an explicit accept-list of a number
    // or a digit string, rejects negatives, and names null in its message.
    // Unlimited has exactly one spelling — omit the field — because two
    // spellings would hash differently and break idempotency. Internal keeps the
    // coercion because it is not the agent-facing boundary. Do not "align" this
    // back to internal.
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
          .pipe(z.coerce.number().int().nonnegative())
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

/**
 * `dineroSchema` recomputes the snapshot from `displayAmount` and reads nothing
 * from the input snapshot except the currency code, so one placeholder currency
 * validates any decimal string. The real conversion happens server-side with the
 * plan version's own currency, in `toDineroPrice()`.
 */
const INTERNAL_PLACEHOLDER_CURRENCY = { code: "USD", base: 10, exponent: 2 } as const

function toInternalPrice(amount: string) {
  return {
    dinero: {
      amount: 0,
      currency: INTERNAL_PLACEHOLDER_CURRENCY,
      scale: INTERNAL_PLACEHOLDER_CURRENCY.exponent,
    },
    displayAmount: amount,
  }
}

function toInternalConfig(config: MonetizationPriceConfig) {
  return {
    ...config,
    ...(config.price === undefined ? {} : { price: toInternalPrice(config.price) }),
    ...(config.tiers === undefined
      ? {}
      : {
          tiers: config.tiers.map((tier) => ({
            ...tier,
            unitPrice: toInternalPrice(tier.unitPrice),
            flatPrice: toInternalPrice(tier.flatPrice),
          })),
        }),
  }
}

/**
 * Which config schema each featureType uses. `validatePlanVersionFeatureMutation`
 * owns this mapping but is not exported, and the exported `parseFeaturesConfig`
 * throws for package features. Only the mapping is repeated; every pricing rule
 * stays inside the schemas named here.
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
 * Runs the priced feature through the featureType's own config schema and then
 * through `planVersionFeatureInsertBaseSchema`, the canonical owner of the
 * feature-level pricing contract. Between them they reject an empty config,
 * unit-mode usage without a price, tiers with a gap, a flat feature carrying a
 * meterConfig, and a usage feature without one — none of which are restated here.
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

  const internalConfig = toInternalConfig(feature.config)
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

  for (const [key, value] of Object.entries(feature.config)) {
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
 * Content address of a plan's desired version: every field
 * `monetizationVersionSchema` declares, with the features sorted by slug and
 * their reset cadence normalized to what the server will store.
 *
 * The whole version is spread rather than hand-listed, so the schema is the only
 * definition of what a version is. A hand-written field list would silently stop
 * hashing any field added later, and two different configurations would then
 * collide onto one plan version.
 *
 * Hashes the boundary form (slugs and decimal strings), never resolved ids or
 * Dinero snapshots, so the same document hashes identically in every project.
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
  const { billingConfig } = plan.version

  return sha256HexSync(
    canonicalJson({
      ...plan.version,
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
