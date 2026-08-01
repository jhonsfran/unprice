/**
 * `monetization.get`: read a project's configuration back in the shape
 * `monetization.apply` accepts.
 *
 * The contract is stronger than "output `apply` will parse". `apply` is
 * idempotent by `configHash`, and the hash is computed over the *parsed*
 * document, so any key this emits that the boundary would normalize away, or any
 * value that only agrees after coercion, mints a spurious draft version for a
 * configuration that did not change. So the document is assembled and then
 * handed to `monetizationConfigSchema` itself: what this returns is parse
 * output, canonical by construction rather than by hand-maintained agreement.
 *
 * Two invariants this path never breaks:
 *
 * - it writes nothing, not even a `configHash` backfill onto the dashboard-
 *   authored versions that have none;
 * - a field that sits *outside* `computeConfigHash` is read from the row that
 *   owns it, never from the plan version's copy. Feature `unitOfMeasure` and the
 *   version's `title`/`description` are labels, deliberately unhashed, and
 *   `apply` refreshes them on drafts through `refreshDraftSnapshots` — echoing a
 *   stale copy back would round-trip into reverting the live row. `meterConfig`
 *   is the opposite case: it is *inside* the hash, so the version's copy is
 *   priced configuration and is exactly what has to be emitted.
 *
 * Two consequences worth stating, because both look like bugs and are not:
 *
 * - a version authored in the dashboard carries no `configHash`, and `apply`
 *   matches only by hash. So feeding this document back always mints a draft for
 *   those plans. That is what "no hash backfill" costs, and it is the cheaper
 *   half of the trade: the alternative is a read that writes.
 * - the document cannot state every column a plan version has. What it would
 *   *misstate* is excluded and reported in `unrepresentablePlans`; what it is
 *   merely *silent* about is emitted and reported in `warnings`. See
 *   `unsupportedBillingConfig` and `droppedVersionSettings`.
 */
import type { Database } from "@unprice/db"
import {
  type BillingConfig,
  type Event,
  type Feature,
  type IntegrationContract,
  type MonetizationEventConfig,
  type MonetizationFeatureConfig,
  type MonetizationPlanConfig,
  type MonetizationPriceConfig,
  type MonetizationVersionFeatureConfig,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  buildIntegrationContract,
  integrationContractSchema,
  monetizationConfigSchema,
  monetizationPlanSchema,
  planVersionFeatureInsertBaseSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import * as z from "zod"

export type GetMonetizationConfigDeps = {
  db: Database
  logger: Logger
}

export const getMonetizationConfigInputSchema = z.object({
  projectId: z.string().min(1),
})

/**
 * The zero-plan document. Reaching for `.innerType()` drops the whole top-level
 * `superRefine`, which is where the cross-plan rules live, so everything it
 * still owns for a plan-less document is restated here — which is only the
 * duplicate-slug checks; every other rule it applies is per-plan or cross-plan
 * and vacuous with no plans.
 */
const emptyMonetizationConfigSchema = monetizationConfigSchema
  .innerType()
  .extend({ plans: z.array(monetizationPlanSchema).max(0) })
  .superRefine((config, ctx) => {
    for (const [key, slugs] of [
      ["events", config.events.map((event) => event.slug)],
      ["features", config.features.map((feature) => feature.slug)],
    ] as const) {
      const seen = new Set<string>()

      slugs.forEach((slug, index) => {
        if (seen.has(slug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate slug "${slug}" in ${key}`,
            path: [key, index, "slug"],
          })
          return
        }
        seen.add(slug)
      })
    }
  })

/**
 * What `get` returns: `monetizationConfigSchema` with exactly one rule relaxed —
 * a project with no plans is a normal answer to a read, while `apply` requires
 * at least one plan.
 *
 * A union rather than an `.innerType()` with a widened `plans`, because
 * `monetizationConfigSchema` is a `ZodEffects` whose `superRefine` owns the
 * exactly-one-default rule, the duplicate-slug checks, and every cross-reference
 * check — and `.innerType()` discards all of them silently. This schema is
 * exported and is the `config` field of the output, so it is what an OpenAPI
 * response contract would be generated from: anything it advertises is what a
 * caller will believe `apply` accepts.
 */
export const monetizationConfigDocumentSchema = z
  .union([monetizationConfigSchema, emptyMonetizationConfigSchema])
  .describe(
    "The project's monetization configuration, in the shape monetization.apply accepts. Empty when the project has no plans"
  )

export const monetizationPlanStateSchema = z.object({
  slug: z.string(),
  publishedVersionId: z
    .string()
    .nullable()
    .describe("The version customers are on right now, or null while the plan is unpublished"),
  draftVersionIds: z
    .array(z.string())
    .describe("Every unpublished version of this plan, most recently created first"),
})

export const unrepresentablePlanReasonSchema = z.enum([
  "no_version",
  "no_features",
  "unsupported_billing_config",
  "invalid_version",
])

export const unrepresentablePlanSchema = z
  .object({
    slug: z.string(),
    reason: unrepresentablePlanReasonSchema,
    message: z.string(),
  })
  .describe("A plan left out of the document because the boundary cannot state its configuration")

/**
 * Settings a stored row carries that the document has no field for. Unlike
 * `unrepresentablePlans` these are not fatal: the document does not *misstate*
 * them, it is silent about them, and dropping a whole plan over a setting the
 * document never claimed would hide the plan from the agent — which is the worse
 * failure, because the agent's next move is to re-add it from defaults.
 *
 * All three fire almost exclusively for dashboard-authored versions, which
 * cannot round-trip without a write anyway. `apply` writes the server defaults
 * these are compared against, so a version it created never warns.
 */
export const monetizationWarningCodeSchema = z.enum([
  "meter_fields_dropped",
  "version_settings_dropped",
  "feature_settings_dropped",
])

export const monetizationWarningSchema = z
  .object({
    planSlug: z.string(),
    featureSlug: z.string().nullable().describe("Null for a warning about the plan version itself"),
    code: monetizationWarningCodeSchema,
    message: z.string(),
  })
  .describe("Configuration this document is silent about. Emitted anyway, never silently dropped")

/**
 * `no_default_plan` also covers a project whose default plan exists but is
 * itself unrepresentable: the document would then name a different plan as the
 * default, and applying it would move the flag on a live project.
 */
export const getMonetizationConfigFailureStateSchema = z.enum([
  "no_default_plan",
  "multiple_default_plans",
  "unrepresentable_configuration",
])

export const getMonetizationConfigOutputSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    config: monetizationConfigDocumentSchema,
    plans: z
      .array(monetizationPlanStateSchema)
      .describe("Version state per plan, in the same order as `config.plans`"),
    unrepresentablePlans: z
      .array(unrepresentablePlanSchema)
      .describe("Plans this project has that the document cannot describe. Reported, never hidden"),
    warnings: z
      .array(monetizationWarningSchema)
      .describe("Stored configuration the emitted document is silent about"),
    integrationContract: integrationContractSchema
      .nullable()
      .describe("Null when the project has no plans to integrate against"),
  }),
  z.object({
    state: getMonetizationConfigFailureStateSchema,
    message: z.string(),
  }),
])

export type GetMonetizationConfigInput = z.input<typeof getMonetizationConfigInputSchema>
export type GetMonetizationConfigOutput = z.infer<typeof getMonetizationConfigOutputSchema>
export type MonetizationConfigDocument = z.infer<typeof monetizationConfigDocumentSchema>
export type MonetizationPlanState = z.infer<typeof monetizationPlanStateSchema>
export type UnrepresentablePlan = z.infer<typeof unrepresentablePlanSchema>
export type MonetizationWarning = z.infer<typeof monetizationWarningSchema>

type StoredPlanVersionFeature = PlanVersionFeature & { feature: Feature }
type StoredPlanVersion = PlanVersion & { planFeatures: StoredPlanVersionFeature[] }
type StoredPlan = Plan & { versions: StoredPlanVersion[] }

type PlanProjection =
  | {
      state: "ok"
      plan: MonetizationPlanConfig
      planState: MonetizationPlanState
      planVersionId: string
      warnings: MonetizationWarning[]
    }
  | ({ state: "unrepresentable" } & UnrepresentablePlan)

/**
 * What `createTemplatePlanVersion` writes for the plan-version columns the
 * document has no field for. Mirrored from `plan-template/materialize.ts`; it is
 * only ever used to decide whether to warn, so drift here makes a warning noisy
 * or absent and can never change what the document emits.
 *
 * Every one of these is editable in the dashboard's plan version form, and all
 * of them are money-path: `trialUnits` and `whenToBill` decide when a customer
 * is first charged, `metadata.includedCreditAmount` grants wallet credit every
 * period.
 */
const SERVER_VERSION_DEFAULTS = {
  whenToBill: "pay_in_advance",
  collectionMethod: "charge_automatically",
  dueBehaviour: "cancel",
  paymentMethodRequired: true,
  autoRenew: true,
  trialUnits: 0,
  gracePeriod: 0,
} as const

/**
 * `planVersionFeatureMetadataSchema`'s own defaults. `apply` passes no metadata
 * at all, so a feature it wrote carries only the two server-derived cadence
 * flags and never reaches these.
 */
const FEATURE_METADATA_DEFAULTS = {
  realtime: false,
  notifyUsageThreshold: 95,
  overageStrategy: "none",
  blockCustomer: false,
  hidden: false,
} as const

/** Meter keys the boundary drops because nothing reads them yet. */
const INERT_METER_KEYS = ["filters", "groupBy", "windowSize"] as const

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function droppedVersionSettings(planVersion: StoredPlanVersion): string[] {
  const columns = planVersion as unknown as Record<string, unknown>
  const dropped = Object.entries(SERVER_VERSION_DEFAULTS)
    .filter(([key, expected]) => columns[key] !== expected)
    .map(([key]) => key)

  if (planVersion.metadata && Object.keys(planVersion.metadata).length > 0) {
    dropped.push("metadata")
  }
  if ((planVersion.tags ?? []).length > 0) dropped.push("tags")

  return dropped
}

function droppedFeatureSettings(planFeature: StoredPlanVersionFeature): string[] {
  const metadata = (planFeature.metadata ?? {}) as Record<string, unknown>
  const dropped = Object.entries(FEATURE_METADATA_DEFAULTS)
    .filter(([key, expected]) => metadata[key] !== undefined && metadata[key] !== expected)
    .map(([key]) => `metadata.${key}`)

  // `null` is how the writer stores "ask for the quantity at subscription time",
  // which the document is equally silent about but is also what it produces.
  if (typeof planFeature.defaultQuantity === "number" && planFeature.defaultQuantity !== 1) {
    dropped.push("defaultQuantity")
  }
  if (planFeature.type && planFeature.type !== "feature") dropped.push("type")

  return dropped
}

function droppedMeterFields(planFeature: StoredPlanVersionFeature): string[] {
  const meterConfig = (planFeature.meterConfig ?? {}) as Record<string, unknown>
  return INERT_METER_KEYS.filter((key) => meterConfig[key] !== undefined)
}

function unrepresentable(
  slug: string,
  reason: UnrepresentablePlan["reason"],
  message: string
): PlanProjection {
  return { state: "unrepresentable", slug, reason, message }
}

function sameBillingConfig(left: BillingConfig, right: BillingConfig): boolean {
  return (
    left.name === right.name &&
    left.billingInterval === right.billingInterval &&
    left.billingIntervalCount === right.billingIntervalCount &&
    left.billingAnchor === right.billingAnchor &&
    left.planType === right.planType
  )
}

/**
 * `monetizationBillingConfigSchema` carries a cadence and nothing else: the
 * server supplies the anchor and the plan type, and it supplies one per plan
 * version, not one per feature. So a version whose anchor is a day of the month,
 * whose plan type is not recurring, or whose features bill or reset on their own
 * cadence says something this document has no words for — and re-applying the
 * document would quietly reset it to the server's defaults.
 *
 * All four are reachable from the dashboard today: `BILLING_CONFIG` offers days
 * 1-31 as a monthly anchor, "Onetime" as a plan type, and the feature editor has
 * its own "Feature Billing" and "Usage Reset" selects.
 */
function unsupportedBillingConfig(planVersion: StoredPlanVersion): string | null {
  const { billingConfig } = planVersion

  if (billingConfig.billingAnchor !== "dayOfCreation") {
    return `bills on day ${billingConfig.billingAnchor} of the period rather than the day the subscription is created`
  }

  if (billingConfig.planType !== "recurring") {
    return `is a "${billingConfig.planType}" plan version`
  }

  for (const planFeature of planVersion.planFeatures) {
    if (!sameBillingConfig(planFeature.billingConfig, billingConfig)) {
      return `prices "${planFeature.feature.slug}" on its own billing cadence`
    }

    const { resetConfig } = planFeature
    if (!resetConfig) continue

    if (
      resetConfig.resetAnchor !== billingConfig.billingAnchor ||
      resetConfig.planType !== billingConfig.planType
    ) {
      return `resets "${planFeature.feature.slug}" on its own anchor`
    }
  }

  return null
}

/**
 * The stored pricing configuration, carrying only the keys that apply to its
 * feature type and with the Dinero snapshots turned back into the decimal
 * strings they were written from.
 *
 * The projection is delegated to `planVersionFeatureInsertBaseSchema`, which
 * owns `normalizePlanVersionFeatureMutation` — restating which keys survive
 * which feature type here would be a second copy of that mapping, free to drift.
 * It matters because the boundary *rejects* a key the normalizer would strip
 * (a `tier` row carrying `price`, a `flat` row carrying `tiers`), and rows
 * written by older code, seeds, or templates are not always normalized.
 *
 * Prices come from `displayAmount`, never recomputed from the Dinero amount and
 * scale: "0.10" and "0.100" are the same money and different hashes.
 */
function toBoundaryFeature(
  planVersion: StoredPlanVersion,
  planFeature: StoredPlanVersionFeature
): MonetizationVersionFeatureConfig | null {
  const normalized = planVersionFeatureInsertBaseSchema.safeParse({
    planVersionId: planFeature.planVersionId,
    featureId: planFeature.featureId,
    featureType: planFeature.featureType,
    config: planFeature.config,
    order: planFeature.order,
    defaultQuantity: planFeature.defaultQuantity ?? 1,
    // `limit` is nullable in the database and the internal schema coerces, so
    // `null` would arrive as a zero allowance instead of "unlimited".
    limit: typeof planFeature.limit === "number" ? planFeature.limit : undefined,
    billingConfig: planVersion.billingConfig,
    resetConfig: planFeature.resetConfig ?? undefined,
    meterConfig: planFeature.meterConfig ?? undefined,
  })

  if (!normalized.success || !normalized.data.config) return null

  const { price, tiers, ...config } = normalized.data.config

  const boundaryConfig: MonetizationPriceConfig = {
    ...config,
    ...(price === undefined ? {} : { price: price.displayAmount }),
    ...(tiers === undefined
      ? {}
      : {
          tiers: tiers.map((tier) => ({
            ...tier,
            unitPrice: tier.unitPrice.displayAmount,
            flatPrice: tier.flatPrice.displayAmount,
          })),
        }),
  }

  // Only the cadence crosses the boundary; the anchor, plan type, and display
  // name are the server's to derive. A reset cadence identical to the billing
  // cadence and an absent one are the same configuration and hash the same, so
  // the stored one is emitted as-is.
  //
  // The `usage` guard is load-bearing, not defensive: `plans/service.ts` only
  // writes `resetConfig` when the *incoming* feature type is usage, so a feature
  // converted from usage to flat keeps a stale reset cadence on the row. The
  // boundary rejects `resetConfig` on a non-usage feature, so emitting it would
  // make the whole plan unrepresentable over a value the server already ignores.
  const resetConfig =
    planFeature.featureType === "usage" && planFeature.resetConfig
      ? {
          interval: planFeature.resetConfig.resetInterval,
          intervalCount: planFeature.resetConfig.resetIntervalCount,
        }
      : undefined

  // The version's own snapshot, because `meterConfig` is inside
  // `computeConfigHash`: it is priced configuration, not a mutable label. The
  // inert `filters`/`groupBy`/`windowSize` are dropped, which the caller learns
  // from `warnings` rather than losing silently.
  const { meterConfig } = planFeature

  return {
    featureSlug: planFeature.feature.slug,
    featureType: planFeature.featureType,
    config: boundaryConfig,
    ...(meterConfig
      ? {
          meterConfig: {
            eventSlug: meterConfig.eventSlug,
            aggregationMethod: meterConfig.aggregationMethod,
            ...(meterConfig.aggregationField
              ? { aggregationField: meterConfig.aggregationField }
              : {}),
          },
        }
      : {}),
    ...(typeof planFeature.limit === "number" ? { limit: planFeature.limit } : {}),
    ...(resetConfig ? { resetConfig } : {}),
  }
}

/**
 * The version a plan is configured by right now: the one customers are on, or
 * the newest draft that actually prices something. A draft with no features is
 * an apply that crashed mid-materialization or a version half-built in the
 * dashboard — it is progress, not a configuration, so it is skipped here and
 * still reported in `draftVersionIds`.
 */
function selectVersions(plan: StoredPlan) {
  const published = plan.versions
    .filter((version) => version.status === "published" && version.active !== false)
    .sort(
      (left, right) =>
        Number(right.latest === true) - Number(left.latest === true) ||
        (right.publishedAt ?? 0) - (left.publishedAt ?? 0) ||
        (right.createdAtM ?? 0) - (left.createdAtM ?? 0)
    )

  const drafts = plan.versions
    .filter((version) => version.status === "draft")
    .sort((left, right) => (right.createdAtM ?? 0) - (left.createdAtM ?? 0))

  const current =
    published[0] ?? drafts.find((version) => version.planFeatures.length > 0) ?? drafts[0] ?? null

  return { published: published[0] ?? null, drafts, current }
}

function projectPlan(plan: StoredPlan): PlanProjection {
  const { published, drafts, current } = selectVersions(plan)

  if (!current) {
    return unrepresentable(plan.slug, "no_version", `Plan "${plan.slug}" has no plan version`)
  }

  if (current.planFeatures.length === 0) {
    return unrepresentable(
      plan.slug,
      "no_features",
      `Plan version ${current.id} of "${plan.slug}" prices no features, and a configuration document must price at least one`
    )
  }

  const unsupported = unsupportedBillingConfig(current)
  if (unsupported) {
    return unrepresentable(
      plan.slug,
      "unsupported_billing_config",
      `Plan version ${current.id} of "${plan.slug}" ${unsupported}, which a configuration document cannot express`
    )
  }

  const features: MonetizationVersionFeatureConfig[] = []
  const warnings: MonetizationWarning[] = []

  const droppedSettings = droppedVersionSettings(current)
  if (droppedSettings.length > 0) {
    warnings.push({
      planSlug: plan.slug,
      featureSlug: null,
      code: "version_settings_dropped",
      message: `Plan version ${current.id} sets ${droppedSettings.join(", ")}, which this document cannot carry. Re-applying it would create a draft using the server defaults instead`,
    })
  }

  // Document order is the stored display order, so re-applying this document
  // leaves the dashboard showing the same thing it shows now.
  const ordered = [...current.planFeatures].sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) ||
      compareStrings(left.feature.slug, right.feature.slug)
  )

  for (const planFeature of ordered) {
    const feature = toBoundaryFeature(current, planFeature)
    if (!feature) {
      return unrepresentable(
        plan.slug,
        "invalid_version",
        `Feature "${planFeature.feature.slug}" of plan version ${current.id} is not a configuration the boundary accepts`
      )
    }
    features.push(feature)

    const featureSlug = planFeature.feature.slug
    const droppedMeter = droppedMeterFields(planFeature)

    if (droppedMeter.length > 0) {
      warnings.push({
        planSlug: plan.slug,
        featureSlug,
        code: "meter_fields_dropped",
        message: `The meter for "${featureSlug}" sets ${droppedMeter.join(", ")}, which this document cannot carry. Nothing reads them today, so behaviour is unchanged`,
      })
    }

    const droppedFeature = droppedFeatureSettings(planFeature)

    if (droppedFeature.length > 0) {
      warnings.push({
        planSlug: plan.slug,
        featureSlug,
        code: "feature_settings_dropped",
        message: `"${featureSlug}" sets ${droppedFeature.join(", ")}, which this document cannot carry. Re-applying it would create a draft using the server defaults instead`,
      })
    }
  }

  // Plan title and description come from the plan row. The plan version carries
  // its own snapshot of both, taken when the version was created.
  const parsed = monetizationPlanSchema.safeParse({
    slug: plan.slug,
    title: plan.title,
    description: plan.description,
    defaultPlan: plan.defaultPlan === true,
    version: {
      currency: current.currency,
      paymentProvider: current.paymentProvider,
      billingConfig: {
        name: current.billingConfig.name,
        interval: current.billingConfig.billingInterval,
        intervalCount: current.billingConfig.billingIntervalCount,
      },
      features,
    },
  })

  if (!parsed.success) {
    return unrepresentable(
      plan.slug,
      "invalid_version",
      `Plan version ${current.id} of "${plan.slug}" is not a configuration the boundary accepts: ${parsed.error.issues[0]?.message ?? "invalid"}`
    )
  }

  return {
    state: "ok",
    plan: parsed.data,
    planState: {
      slug: plan.slug,
      publishedVersionId: published?.id ?? null,
      draftVersionIds: drafts.map(({ id }) => id),
    },
    planVersionId: current.id,
    warnings,
  }
}

function unrepresentableConfiguration(error: z.ZodError): GetMonetizationConfigOutput {
  return {
    state: "unrepresentable_configuration",
    message: `This project's configuration cannot be described by a configuration document: ${error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  }
}

function toBoundaryEvent(event: Event): MonetizationEventConfig {
  return {
    slug: event.slug,
    name: event.name,
    availableProperties: event.availableProperties ?? [],
  }
}

function toBoundaryFeatureDeclaration(feature: Feature): MonetizationFeatureConfig {
  return {
    slug: feature.slug,
    title: feature.title,
    // `description` is nullable in the database and the boundary takes a string
    // or nothing, so only a missing one is omitted. An empty one is emitted as
    // written: `apply` compares the declaration against the row it already has,
    // and turning "" into an absent key is a difference it would act on.
    ...(feature.description === null || feature.description === undefined
      ? {}
      : { description: feature.description }),
    unitOfMeasure: feature.unitOfMeasure,
  }
}

export async function getMonetizationConfig(
  deps: GetMonetizationConfigDeps,
  rawInput: GetMonetizationConfigInput
): Promise<Result<GetMonetizationConfigOutput, FetchError>> {
  const { projectId } = getMonetizationConfigInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "monetization.get",
      project_id: projectId,
    },
  })

  const stored = await wrapResult(
    Promise.all([
      deps.db.query.plans.findMany({
        with: { versions: { with: { planFeatures: { with: { feature: true } } } } },
        where: (plan, { eq }) => eq(plan.projectId, projectId),
      }),
      deps.db.query.features.findMany({
        where: (feature, { eq }) => eq(feature.projectId, projectId),
      }),
      deps.db.query.events.findMany({
        where: (event, { eq }) => eq(event.projectId, projectId),
      }),
    ]),
    (error) =>
      new FetchError({
        message: `error reading the project monetization configuration: ${error.message}`,
        retry: false,
      })
  )

  if (stored.err) {
    deps.logger.error(stored.err, {
      context: "error reading the project monetization configuration",
      projectId,
    })
    return Err(stored.err)
  }

  const [planRows, featureRows, eventRows] = stored.val as [StoredPlan[], Feature[], Event[]]

  // Sorted by slug throughout: the agent diffs this document locally, and a
  // stable order is the difference between a diff and a rewrite. None of these
  // orders is hashed.
  const events = [...eventRows]
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map(toBoundaryEvent)
  const features = [...featureRows]
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map(toBoundaryFeatureDeclaration)

  const projections = [...planRows]
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map(projectPlan)

  const representable = projections.filter(
    (projection): projection is Extract<PlanProjection, { state: "ok" }> =>
      projection.state === "ok"
  )
  const unrepresentablePlans: UnrepresentablePlan[] = projections
    .filter(
      (projection): projection is Extract<PlanProjection, { state: "unrepresentable" }> =>
        projection.state === "unrepresentable"
    )
    .map(({ slug, reason, message }) => ({ slug, reason, message }))

  if (representable.length === 0) {
    // Nothing to be the default of, and nothing to integrate against. The
    // events and features still go through the schema, so an empty project's
    // document is parse output on the same terms as every other one.
    const empty = monetizationConfigDocumentSchema.safeParse({ events, features, plans: [] })
    if (!empty.success) return Ok(unrepresentableConfiguration(empty.error))

    deps.logger.info("monetization configuration read", {
      projectId,
      plans: 0,
      events: events.length,
      features: features.length,
      unrepresentablePlans: unrepresentablePlans.length,
    })

    return Ok({
      state: "ok",
      config: empty.data,
      plans: [],
      unrepresentablePlans,
      warnings: [],
      integrationContract: null,
    })
  }

  const defaults = planRows.filter((plan) => plan.defaultPlan === true)

  if (defaults.length > 1) {
    return Ok({
      state: "multiple_default_plans",
      message: `This project has ${defaults.length} default plans (${defaults
        .map(({ slug }) => slug)
        .join(", ")}). Exactly one plan can be the default customers fall back to`,
    })
  }

  const [defaultPlan] = defaults

  if (!defaultPlan) {
    return Ok({
      state: "no_default_plan",
      message:
        "This project has no default plan. Exactly one plan must be the default customers fall back to",
    })
  }

  const excludedDefault = unrepresentablePlans.find(({ slug }) => slug === defaultPlan.slug)

  if (excludedDefault) {
    return Ok({
      state: "no_default_plan",
      message: `The default plan "${defaultPlan.slug}" cannot be described by a configuration document, so this project has no expressible default: ${excludedDefault.message}`,
    })
  }

  const document = monetizationConfigSchema.safeParse({
    events,
    features,
    plans: representable.map(({ plan }) => plan),
  })

  if (!document.success) {
    // Cross-plan rules the per-plan projection cannot see, such as one feature
    // metering two different events in two different plans.
    return Ok(unrepresentableConfiguration(document.error))
  }

  const resolvedPlanVersions: Record<string, string> = {}
  for (const { plan, planVersionId } of representable) {
    resolvedPlanVersions[plan.slug] = planVersionId
  }

  const integrationContract: IntegrationContract = buildIntegrationContract(
    document.data,
    resolvedPlanVersions
  )

  const warnings = representable.flatMap(({ warnings: planWarnings }) => planWarnings)

  deps.logger.info("monetization configuration read", {
    projectId,
    plans: document.data.plans.length,
    events: events.length,
    features: features.length,
    unrepresentablePlans: unrepresentablePlans.length,
    warnings: warnings.length,
  })

  return Ok({
    state: "ok",
    config: document.data,
    plans: representable.map(({ planState }) => planState),
    unrepresentablePlans,
    warnings,
    integrationContract,
  })
}
