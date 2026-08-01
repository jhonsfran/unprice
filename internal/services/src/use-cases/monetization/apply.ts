/**
 * `monetization.apply`: turn one configuration document into draft plan versions.
 *
 * The whole idempotency mechanism is `configHash` on the plan version. The agent
 * holds no state, a retry is literally the same request body, and a crash leaves
 * the half-materialized draft as its own progress record — the next apply finds
 * it by hash and finishes it.
 *
 * Two invariants this path never breaks:
 *
 * - the project comes from the caller's credential, never from the document;
 * - nothing is ever published, edited, archived, or deleted here. Publishing is
 *   a human action in the dashboard.
 */
import type { Database } from "@unprice/db"
import {
  type BillingConfig,
  type ConfigFeatureVersionType,
  type Currency,
  type Feature,
  type MeterConfig,
  type MonetizationPlanConfig,
  type MonetizationPriceConfig,
  type MonetizationVersionFeatureConfig,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  type ResetConfig,
  buildIntegrationContract,
  computeConfigHash,
  configFeatureSchema,
  integrationContractSchema,
  monetizationConfigSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import * as z from "zod"
import type { ServiceContext } from "../../context"
import {
  type MaterializeContext,
  type PlanTemplateMaterializeCaches,
  createTemplatePlanVersion,
  getOrCreateEvent,
  getOrCreateFeature,
  getOrCreatePlan,
  getOrCreatePlanVersionFeature,
  isTemplatePlanVersionComplete,
  toDineroPrice,
} from "../plan-template/materialize"

/** Gap between adjacent features, matching what the plan templates already write. */
const FEATURE_ORDER_STRIDE = 1024

export type ApplyMonetizationConfigDeps = {
  services: Pick<ServiceContext, "plans" | "features" | "events">
  db: Database
  logger: Logger
}

export const applyMonetizationConfigInputSchema = z.object({
  projectId: z.string().min(1),
  config: monetizationConfigSchema,
})

export const monetizationPlanOutcomeSchema = z.object({
  slug: z.string(),
  planVersionId: z.string(),
  status: z
    .enum(["created", "unchanged", "published"])
    .describe(
      "'created' when this apply wrote or finished a draft, 'unchanged' when a complete draft already matched, 'published' when a live version already matches"
    ),
})

/**
 * States the caller can act on. `slug_conflict` and `unresolved_reference` are
 * this use case's own; the rest are the plan-version writer's, surfaced instead
 * of being flattened into an opaque error, exactly as `plan-template/apply`
 * surfaces them.
 */
export const applyMonetizationConfigFailureStateSchema = z.enum([
  "plan_not_found",
  "plan_version_not_found",
  "plan_version_published",
  "plan_version_feature_not_found",
  "feature_not_found",
  "usage_meter_config_required",
  "invalid_reset_config",
])

export const applyMonetizationConfigOutputSchema = z.union([
  z.object({
    state: z.literal("ok"),
    plans: z.array(monetizationPlanOutcomeSchema),
    staleDrafts: z
      .array(z.string())
      .describe(
        "Drafts of these plans made by an earlier, now-superseded document. Reported, never deleted"
      ),
    integrationContract: integrationContractSchema,
  }),
  z.object({
    state: z.enum(["slug_conflict", "unresolved_reference"]),
    slug: z.string(),
    message: z.string(),
  }),
  z.object({ state: applyMonetizationConfigFailureStateSchema }),
])

export type ApplyMonetizationConfigInput = z.input<typeof applyMonetizationConfigInputSchema>
export type ApplyMonetizationConfigOutput = z.infer<typeof applyMonetizationConfigOutputSchema>
export type MonetizationPlanOutcome = z.infer<typeof monetizationPlanOutcomeSchema>

type ApplyFailure = Exclude<ApplyMonetizationConfigOutput, { state: "ok" }>
type MaterializeOutcome = { state: "ok" } | ApplyFailure

type ConfigPlanVersion = PlanVersion & {
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
}

function unresolved(slug: string, message: string): ApplyFailure {
  return { state: "unresolved_reference", slug, message }
}

/**
 * Boundary prices are decimal strings; stored prices are Dinero snapshots. The
 * converted object goes back through the canonical config schema so the stored
 * shape is decided by the same code the dashboard writes through, not by a cast.
 */
function toStoredConfig(
  config: MonetizationPriceConfig,
  currency: Currency
): ConfigFeatureVersionType {
  return configFeatureSchema.parse({
    ...config,
    ...(config.price === undefined ? {} : { price: toDineroPrice(config.price, currency) }),
    ...(config.tiers === undefined
      ? {}
      : {
          tiers: config.tiers.map((tier) => ({
            ...tier,
            unitPrice: toDineroPrice(tier.unitPrice, currency),
            flatPrice: toDineroPrice(tier.flatPrice, currency),
          })),
        }),
  })
}

/**
 * The document declares a reset cadence; the server supplies the anchor, plan
 * type, and display name. A cadence identical to the billing cadence returns
 * `undefined` so the writer derives it: hand-building it there would give the
 * same cadence a different name and get the feature flagged as an override.
 */
function toStoredResetConfig(
  resetConfig: MonetizationVersionFeatureConfig["resetConfig"],
  billingConfig: BillingConfig
): ResetConfig | undefined {
  if (!resetConfig) return undefined

  if (
    resetConfig.interval === billingConfig.billingInterval &&
    resetConfig.intervalCount === billingConfig.billingIntervalCount
  ) {
    return undefined
  }

  return {
    name: `${resetConfig.intervalCount} ${resetConfig.interval}`,
    resetInterval: resetConfig.interval,
    resetIntervalCount: resetConfig.intervalCount,
    resetAnchor: billingConfig.billingAnchor,
    planType: billingConfig.planType,
  }
}

/**
 * `unitOfMeasure` is a label, so it is deliberately outside the hash: renaming
 * "message" to "messages" must not create a new plan version. But the plan
 * version feature stores its own snapshot of it, which therefore drifts when the
 * feature is renamed in the dashboard. A matched draft is mutable and nobody is
 * billed against it, so its snapshot is refreshed. A published version keeps the
 * label it was published with.
 */
async function refreshUnitOfMeasureSnapshots(
  deps: ApplyMonetizationConfigDeps,
  projectId: string,
  planVersion: ConfigPlanVersion
): Promise<Result<MaterializeOutcome, FetchError>> {
  for (const planFeature of planVersion.planFeatures) {
    const current = planFeature.feature.unitOfMeasure ?? "units"
    if (planFeature.unitOfMeasure === current) continue

    const updated = await deps.services.plans.updatePlanVersionFeatureRecord({
      projectId,
      id: planFeature.id,
      planVersionId: planVersion.id,
      unitOfMeasure: current,
      hasMeterConfigOverride: false,
    })
    if (updated.err) return Err(updated.err)
    if (updated.val.state !== "ok") return Ok({ state: updated.val.state })
  }

  return Ok({ state: "ok" })
}

/**
 * Writes the document's priced features onto a draft version. Feature order
 * follows the document so the dashboard shows what the agent wrote; order is not
 * hashed, so re-sending the same features in another order changes nothing.
 */
async function materializeVersionFeatures(
  context: MaterializeContext,
  { plan, planVersion }: { plan: MonetizationPlanConfig; planVersion: PlanVersion }
): Promise<Result<MaterializeOutcome, FetchError>> {
  for (const [index, versionFeature] of plan.version.features.entries()) {
    const feature = context.caches.features.get(versionFeature.featureSlug)
    if (!feature) {
      return Ok(
        unresolved(
          versionFeature.featureSlug,
          `Plan "${plan.slug}" prices feature "${versionFeature.featureSlug}", which this document does not declare`
        )
      )
    }

    let meterConfig: MeterConfig | undefined

    if (versionFeature.meterConfig) {
      const { eventSlug, aggregationField } = versionFeature.meterConfig
      const declared = context.caches.events.get(eventSlug)

      if (!declared) {
        return Ok(
          unresolved(
            eventSlug,
            `Feature "${versionFeature.featureSlug}" meters event "${eventSlug}", which this document does not declare`
          )
        )
      }

      // Re-resolving through getOrCreateEvent merges the meter's aggregation
      // field into the event's available properties, so the event knows which
      // numeric payload the application has to send.
      const event = await getOrCreateEvent(context, {
        slug: eventSlug,
        name: declared.name,
        availableProperties: aggregationField ? [aggregationField] : [],
      })
      if (event.err) return Err(event.err)

      meterConfig = {
        ...versionFeature.meterConfig,
        eventId: event.val.id,
        eventSlug: event.val.slug,
      }
    }

    const written = await getOrCreatePlanVersionFeature(context, {
      planVersion,
      feature,
      featureType: versionFeature.featureType,
      config: toStoredConfig(versionFeature.config, plan.version.currency),
      order: (index + 1) * FEATURE_ORDER_STRIDE,
      limit: versionFeature.limit,
      resetConfig: toStoredResetConfig(versionFeature.resetConfig, planVersion.billingConfig),
      meterConfig,
    })
    if (written.err) return Err(written.err)
    if (written.val.state !== "ok") return Ok({ state: written.val.state })
  }

  return Ok({ state: "ok" })
}

/**
 * Makes the document's default plan the project's default.
 *
 * `updatePlanRecord` refuses to move the flag while another plan still holds it,
 * so the current holder is cleared first — including a holder that is not in the
 * document, since the document is the whole statement of how this project makes
 * money.
 */
async function releaseDefaultPlan(
  deps: ApplyMonetizationConfigDeps,
  projectId: string,
  defaultPlanId: string
): Promise<Result<null, FetchError>> {
  const currentDefault = await wrapResult(
    deps.db.query.plans.findFirst({
      where: (plan, { and, eq }) => and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
    }),
    (error) =>
      new FetchError({
        message: `error reading the project default plan: ${error.message}`,
        retry: false,
      })
  )
  if (currentDefault.err) return Err(currentDefault.err)

  const holder = (currentDefault.val as Plan | undefined) ?? null
  if (!holder || holder.id === defaultPlanId) return Ok(null)

  const cleared = await deps.services.plans.updatePlanRecord({
    projectId,
    id: holder.id,
    defaultPlan: false,
    // updatePlanRecord rewrites both exclusivity flags on every call, so the one
    // it was not asked about has to be handed back to it.
    enterprisePlan: holder.enterprisePlan ?? false,
  })
  if (cleared.err) return Err(cleared.err)
  if (cleared.val.state !== "ok") {
    return Err(
      new FetchError({
        message: `could not release the default plan from "${holder.slug}": ${cleared.val.state}`,
        retry: false,
      })
    )
  }

  return Ok(null)
}

export async function applyMonetizationConfig(
  deps: ApplyMonetizationConfigDeps,
  rawInput: ApplyMonetizationConfigInput
): Promise<Result<ApplyMonetizationConfigOutput, FetchError>> {
  const { projectId, config } = applyMonetizationConfigInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "monetization.apply",
      project_id: projectId,
    },
  })

  const caches: PlanTemplateMaterializeCaches = {
    features: new Map(),
    events: new Map(),
    planVersionFeatureSlugs: new Map(),
  }
  const context: MaterializeContext = { deps, projectId, caches }

  // 1. Preflight every declared feature before anything is written, so an
  //    incompatible slug leaves the project exactly as it was.
  for (const declared of config.features) {
    const existing = await deps.services.features.getFeatureBySlug({
      projectId,
      slug: declared.slug,
    })
    if (existing.err) return Err(existing.err)
    if (!existing.val) continue

    const stored = existing.val.unitOfMeasure ?? "units"
    if (declared.unitOfMeasure !== undefined && declared.unitOfMeasure !== stored) {
      return Ok({
        state: "slug_conflict",
        slug: declared.slug,
        message: `Feature "${declared.slug}" already exists in this project measured in "${stored}", not "${declared.unitOfMeasure}". Use another slug, or keep the existing unit`,
      })
    }

    caches.features.set(declared.slug, existing.val)
  }

  // 2. Events first: a meter points at an event, so the event has to exist
  //    before any plan version snapshots it.
  for (const declared of config.events) {
    const event = await getOrCreateEvent(context, {
      slug: declared.slug,
      name: declared.name,
      availableProperties: declared.availableProperties ?? [],
    })
    if (event.err) return Err(event.err)
  }

  for (const declared of config.features) {
    const feature = await getOrCreateFeature(context, declared)
    if (feature.err) return Err(feature.err)
  }

  // 3. Plans, then the default flag.
  const planRows = new Map<string, Plan>()

  for (const plan of config.plans) {
    const row = await getOrCreatePlan(context, {
      slug: plan.slug,
      title: plan.title,
      description: plan.description ?? "",
    })
    if (row.err) return Err(row.err)
    planRows.set(plan.slug, row.val)
  }

  const defaultPlanConfig = config.plans.find((plan) => plan.defaultPlan)
  const defaultPlanRow = defaultPlanConfig && planRows.get(defaultPlanConfig.slug)

  if (!defaultPlanConfig || !defaultPlanRow) {
    // monetizationConfigSchema requires exactly one default plan, so reaching
    // here means the parsed document and this code disagree.
    return Err(
      new FetchError({
        message: "Monetization configuration has no default plan",
        retry: false,
      })
    )
  }

  const released = await releaseDefaultPlan(deps, projectId, defaultPlanRow.id)
  if (released.err) return Err(released.err)

  for (const plan of config.plans) {
    const row = planRows.get(plan.slug)
    if (!row) return Ok(unresolved(plan.slug, `Plan "${plan.slug}" was not resolved`))

    const description = plan.description ?? ""
    const defaultPlan = plan.defaultPlan === true

    if (
      row.title === plan.title &&
      (row.description ?? "") === description &&
      (row.defaultPlan ?? false) === defaultPlan
    ) {
      continue
    }

    const updated = await deps.services.plans.updatePlanRecord({
      projectId,
      id: row.id,
      title: plan.title,
      description,
      defaultPlan,
      enterprisePlan: defaultPlan ? false : (row.enterprisePlan ?? false),
    })
    if (updated.err) return Err(updated.err)
    if (updated.val.state !== "ok") {
      return Err(
        new FetchError({
          message: `could not update plan "${plan.slug}": ${updated.val.state}`,
          // Another writer holds the default; the same document applied again
          // after it settles converges.
          retry: updated.val.state === "default_plan_exists",
        })
      )
    }

    planRows.set(plan.slug, updated.val.plan)
  }

  // 4. One content-addressed draft per plan.
  const plans: MonetizationPlanOutcome[] = []
  const staleDrafts: string[] = []
  const resolvedPlanVersions: Record<string, string> = {}
  const hashes: Record<string, string> = {}
  const counts = { created: 0, unchanged: 0, published: 0, resumed: 0 }

  for (const plan of config.plans) {
    const planRow = planRows.get(plan.slug)
    if (!planRow) return Ok(unresolved(plan.slug, `Plan "${plan.slug}" was not resolved`))

    // Computed from parse output, never from the request body: several boundary
    // fields coerce or default, so the raw body hashes differently.
    const configHash = computeConfigHash(plan)
    hashes[plan.slug] = configHash

    const matches = await wrapResult(
      deps.db.query.versions.findMany({
        with: { planFeatures: { with: { feature: true } } },
        where: (version, { and, eq }) =>
          and(
            eq(version.projectId, projectId),
            eq(version.planId, planRow.id),
            eq(version.configHash, configHash)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error looking up the plan version for a config hash: ${error.message}`,
          retry: false,
        })
    )
    if (matches.err) {
      deps.logger.error(matches.err, {
        context: "error looking up the plan version for a config hash",
        projectId,
        planId: planRow.id,
      })
      return Err(matches.err)
    }

    const superseded = await wrapResult(
      deps.db.query.versions.findMany({
        columns: { id: true },
        where: (version, { and, eq, ne, isNotNull }) =>
          and(
            eq(version.projectId, projectId),
            eq(version.planId, planRow.id),
            eq(version.status, "draft"),
            // Drafts without a hash were authored in the dashboard or by a plan
            // template. They were never this document's, so they are not stale.
            isNotNull(version.configHash),
            ne(version.configHash, configHash)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error listing superseded drafts: ${error.message}`,
          retry: false,
        })
    )
    if (superseded.err) return Err(superseded.err)
    staleDrafts.push(...superseded.val.map(({ id }) => id))

    const candidates = matches.val as ConfigPlanVersion[]
    const publishedMatch = candidates.find((version) => version.status === "published")

    if (publishedMatch) {
      counts.published += 1
      plans.push({ slug: plan.slug, planVersionId: publishedMatch.id, status: "published" })
      resolvedPlanVersions[plan.slug] = publishedMatch.id
      continue
    }

    const draftMatch = candidates
      .filter((version) => version.status === "draft")
      .sort((left, right) => (right.createdAtM ?? 0) - (left.createdAtM ?? 0))[0]

    const expectedFeatureSlugs = new Set(
      plan.version.features.map((feature) => feature.featureSlug)
    )
    let planVersion: PlanVersion
    let complete = false

    if (draftMatch) {
      const refreshed = await refreshUnitOfMeasureSnapshots(deps, projectId, draftMatch)
      if (refreshed.err) return Err(refreshed.err)
      if (refreshed.val.state !== "ok") return Ok(refreshed.val)

      const featureSlugs = new Set(draftMatch.planFeatures.map(({ feature }) => feature.slug))
      caches.planVersionFeatureSlugs.set(draftMatch.id, featureSlugs)
      planVersion = draftMatch
      complete = isTemplatePlanVersionComplete(featureSlugs, expectedFeatureSlugs)
      if (!complete) counts.resumed += 1
    } else {
      const created = await createTemplatePlanVersion(context, {
        planId: planRow.id,
        template: {
          plan: { title: plan.title, description: plan.description ?? "" },
          billingConfig: plan.version.billingConfig,
        },
        currency: plan.version.currency,
        paymentProvider: plan.version.paymentProvider,
        tags: [],
        configHash,
      })
      if (created.err) return Err(created.err)
      if (created.val.state !== "ok") return Ok({ state: created.val.state })

      planVersion = created.val.planVersion
      caches.planVersionFeatureSlugs.set(planVersion.id, new Set())
      counts.created += 1
    }

    if (!complete) {
      const materialized = await materializeVersionFeatures(context, { plan, planVersion })
      if (materialized.err) return Err(materialized.err)
      if (materialized.val.state !== "ok") return Ok(materialized.val)

      if (
        !isTemplatePlanVersionComplete(
          caches.planVersionFeatureSlugs.get(planVersion.id) ?? new Set(),
          expectedFeatureSlugs
        )
      ) {
        return Err(
          new FetchError({
            message: `Plan version ${planVersion.id} is missing expected features`,
            retry: true,
          })
        )
      }
    } else {
      counts.unchanged += 1
    }

    plans.push({
      slug: plan.slug,
      planVersionId: planVersion.id,
      status: complete ? "unchanged" : "created",
    })
    resolvedPlanVersions[plan.slug] = planVersion.id
  }

  const integrationContract = buildIntegrationContract(config, resolvedPlanVersions)

  // `created` counts fresh drafts and `resumed` counts half-materialized ones
  // finished in place. Both are reported to the caller as "created"; only this
  // event separates them.
  deps.logger.info("monetization configuration applied", {
    projectId,
    plans: plans.map((outcome) => ({ ...outcome, configHash: hashes[outcome.slug] })),
    staleDrafts: staleDrafts.length,
    ...counts,
  })

  return Ok({ state: "ok", plans, staleDrafts, integrationContract })
}
