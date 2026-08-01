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
 *
 * The document is the whole statement of how the project makes money, so
 * unversioned labels — feature title and description, plan title and
 * description, and the plan version's own copies of them — are brought in line
 * with it. Anything that changes what a customer is charged goes into the hash
 * and therefore into a new draft instead.
 */
import type { Database } from "@unprice/db"
import {
  type BillingConfig,
  type ConfigFeatureVersionType,
  type Currency,
  type Feature,
  type MeterConfig,
  type MonetizationConfig,
  type MonetizationFeatureConfig,
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

export const monetizationStaleDraftSchema = z.object({
  slug: z.string().describe("Slug of the plan the draft belongs to"),
  planVersionId: z.string(),
})

/**
 * States the caller can act on. `slug_conflict` and `unresolved_reference` are
 * this use case's own; the rest come from the plan and plan-version writers and
 * are surfaced instead of being flattened into an opaque error, exactly as
 * `plan-template/apply` surfaces them.
 */
export const applyMonetizationConfigFailureStateSchema = z.enum([
  "plan_not_found",
  "plan_version_not_found",
  "plan_version_published",
  "plan_version_feature_not_found",
  "feature_not_found",
  "usage_meter_config_required",
  "invalid_reset_config",
  "default_enterprise_conflict",
])

export const applyMonetizationConfigOutputSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    plans: z.array(monetizationPlanOutcomeSchema),
    staleDrafts: z
      .array(monetizationStaleDraftSchema)
      .describe(
        "Drafts made by an earlier, now-superseded document, plus same-hash duplicates left by a concurrent apply. Reported, never deleted"
      ),
    integrationContract: integrationContractSchema,
  }),
  z.object({ state: z.literal("slug_conflict"), slug: z.string(), message: z.string() }),
  z.object({ state: z.literal("unresolved_reference"), slug: z.string(), message: z.string() }),
  z.object({
    state: applyMonetizationConfigFailureStateSchema,
    // A document carries many plans and many features, so a bare state cannot be
    // acted on. Whoever raises one knows where it happened and says so.
    planSlug: z.string().optional(),
    featureSlug: z.string().optional(),
  }),
])

export type ApplyMonetizationConfigInput = z.input<typeof applyMonetizationConfigInputSchema>
export type ApplyMonetizationConfigOutput = z.infer<typeof applyMonetizationConfigOutputSchema>
export type MonetizationPlanOutcome = z.infer<typeof monetizationPlanOutcomeSchema>
export type MonetizationStaleDraft = z.infer<typeof monetizationStaleDraftSchema>

type ApplyFailure = Exclude<ApplyMonetizationConfigOutput, { state: "ok" }>
type WriteFailureState = z.infer<typeof applyMonetizationConfigFailureStateSchema>
type FailureLocator = { planSlug?: string; featureSlug?: string }
type PendingFeature = { declared: MonetizationFeatureConfig; existing: Feature | null }

type ConfigPlanVersion = PlanVersion & {
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
}

/** How the plan's version was obtained. Only the wide event separates these. */
type PlanDraftOrigin = "created" | "resumed" | "unchanged" | "published"

export type PlanDraftResolution = {
  state: "ok"
  outcome: MonetizationPlanOutcome
  staleDrafts: MonetizationStaleDraft[]
  configHash: string
  origin: PlanDraftOrigin
}

function unresolved(slug: string, message: string): ApplyFailure {
  return { state: "unresolved_reference", slug, message }
}

function writeFailure(state: WriteFailureState, locator: FailureLocator = {}): ApplyFailure {
  return { state, ...locator }
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
 * `undefined` so the writer derives it: hand-building it here would give the
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
 * Brings a matched draft's denormalized copies back in line with the document.
 *
 * Two things drift. The plan version snapshots the plan's title and description
 * when it is created, and `unitOfMeasure` is a label deliberately kept outside
 * the hash — renaming "message" to "messages" must not create a new plan version
 * — while the plan version feature keeps its own copy of it. Drafts are mutable
 * and nobody is billed against one, so both are refreshed. A published version
 * keeps whatever it was published with; this never runs on one.
 */
async function refreshDraftSnapshots(
  { deps, projectId }: MaterializeContext,
  plan: MonetizationPlanConfig,
  draft: ConfigPlanVersion
): Promise<Result<{ state: "ok"; planVersion: PlanVersion } | ApplyFailure, FetchError>> {
  let planVersion: PlanVersion = draft
  const description = plan.description ?? ""

  if (draft.title !== plan.title || draft.description !== description) {
    const updated = await deps.services.plans.updatePlanVersionRecord({
      projectId,
      id: draft.id,
      title: plan.title,
      description,
    })
    if (updated.err) return Err(updated.err)
    if (updated.val.state !== "ok") {
      return Ok(writeFailure("plan_version_not_found", { planSlug: plan.slug }))
    }

    planVersion = updated.val.planVersion
  }

  for (const planFeature of draft.planFeatures) {
    const current = planFeature.feature.unitOfMeasure ?? "units"
    if (planFeature.unitOfMeasure === current) continue

    const updated = await deps.services.plans.updatePlanVersionFeatureRecord({
      projectId,
      id: planFeature.id,
      planVersionId: draft.id,
      unitOfMeasure: current,
      hasMeterConfigOverride: false,
    })
    if (updated.err) return Err(updated.err)
    if (updated.val.state !== "ok") {
      return Ok(
        writeFailure(updated.val.state, {
          planSlug: plan.slug,
          featureSlug: planFeature.feature.slug,
        })
      )
    }
  }

  return Ok({ state: "ok", planVersion })
}

/**
 * Writes the document's priced features onto a draft version.
 *
 * Order follows the document so the dashboard shows what the agent wrote, and
 * continues from what the version already carries. Order is not hashed, so a
 * resumed draft can legitimately be finished from a reordered document, and
 * numbering from the document index alone would then put two features on the
 * same order.
 */
async function materializeVersionFeatures(
  context: MaterializeContext,
  { plan, planVersion }: { plan: MonetizationPlanConfig; planVersion: PlanVersion }
): Promise<Result<{ state: "ok" } | ApplyFailure, FetchError>> {
  const alreadyWritten =
    context.caches.planVersionFeatureSlugs.get(planVersion.id) ?? new Set<string>()
  let order = alreadyWritten.size

  for (const versionFeature of plan.version.features) {
    if (alreadyWritten.has(versionFeature.featureSlug)) continue

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

    order += 1
    const result = await getOrCreatePlanVersionFeature(context, {
      planVersion,
      feature,
      featureType: versionFeature.featureType,
      config: toStoredConfig(versionFeature.config, plan.version.currency),
      order: order * FEATURE_ORDER_STRIDE,
      limit: versionFeature.limit,
      resetConfig: toStoredResetConfig(versionFeature.resetConfig, planVersion.billingConfig),
      meterConfig,
    })
    if (result.err) return Err(result.err)
    if (result.val.state !== "ok") {
      return Ok(
        writeFailure(result.val.state, {
          planSlug: plan.slug,
          featureSlug: versionFeature.featureSlug,
        })
      )
    }
  }

  return Ok({ state: "ok" })
}

/**
 * Resolves one plan's desired version: reuse whatever already carries this
 * content address, finish it if it is half-written, or write a new draft.
 *
 * Exported so draft resolution can be exercised without a whole apply — the hash
 * lookup, the superseded-draft query, and the resume path are where the real
 * behaviour lives.
 */
export async function resolvePlanDraft(
  context: MaterializeContext,
  { plan, planRow }: { plan: MonetizationPlanConfig; planRow: Plan }
): Promise<Result<PlanDraftResolution | ApplyFailure, FetchError>> {
  const { deps, projectId, caches } = context

  // Computed from parse output, never from the request body: several boundary
  // fields coerce or default, so the raw body hashes differently.
  const configHash = computeConfigHash(plan)
  const staleDrafts: MonetizationStaleDraft[] = []
  const asStale = (planVersionId: string) => ({ slug: plan.slug, planVersionId })

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
  staleDrafts.push(...superseded.val.map(({ id }) => asStale(id)))

  const candidates = matches.val as ConfigPlanVersion[]
  const sameHashDrafts = candidates
    .filter((version) => version.status === "draft")
    .sort((left, right) => (right.createdAtM ?? 0) - (left.createdAtM ?? 0))
  const publishedMatch = candidates.find((version) => version.status === "published")

  if (publishedMatch) {
    // A draft carrying a hash that is already live adds nothing.
    staleDrafts.push(...sameHashDrafts.map(({ id }) => asStale(id)))

    return Ok({
      state: "ok",
      outcome: { slug: plan.slug, planVersionId: publishedMatch.id, status: "published" },
      staleDrafts,
      configHash,
      origin: "published",
    })
  }

  // The index is deliberately not unique, so two applies racing on one document
  // can leave twins. The newest wins and the rest are reported, which is the
  // reconciliation the schema comment promises.
  const [draftMatch, ...duplicateDrafts] = sameHashDrafts
  staleDrafts.push(...duplicateDrafts.map(({ id }) => asStale(id)))

  const expectedFeatureSlugs = new Set(plan.version.features.map(({ featureSlug }) => featureSlug))
  let planVersion: PlanVersion
  let complete = false
  let origin: PlanDraftOrigin

  if (draftMatch) {
    const refreshed = await refreshDraftSnapshots(context, plan, draftMatch)
    if (refreshed.err) return Err(refreshed.err)
    if (refreshed.val.state !== "ok") return Ok(refreshed.val)

    const featureSlugs = new Set(draftMatch.planFeatures.map(({ feature }) => feature.slug))
    caches.planVersionFeatureSlugs.set(draftMatch.id, featureSlugs)
    planVersion = refreshed.val.planVersion
    complete = isTemplatePlanVersionComplete(featureSlugs, expectedFeatureSlugs)
    origin = complete ? "unchanged" : "resumed"
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
    if (created.val.state !== "ok") {
      return Ok(writeFailure(created.val.state, { planSlug: plan.slug }))
    }

    planVersion = created.val.planVersion
    caches.planVersionFeatureSlugs.set(planVersion.id, new Set())
    origin = "created"
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
  }

  return Ok({
    state: "ok",
    outcome: {
      slug: plan.slug,
      planVersionId: planVersion.id,
      status: complete ? "unchanged" : "created",
    },
    staleDrafts,
    configHash,
    origin,
  })
}

/**
 * Hands the default flag to `planId`.
 *
 * `updatePlanRecord` refuses to move the flag while another plan still holds it,
 * so the current holder is released first — including a holder the document does
 * not mention, since the document is the whole statement of how this project
 * makes money. Called immediately before the new holder is written: a project
 * with no default plan cannot answer a `customers.signUp` that omits `planSlug`,
 * so that window is kept to two adjacent writes.
 *
 * Returns the row it demoted, because the caller is holding plan rows it read
 * before this ran: a stale copy still claiming the flag makes the very next
 * `updatePlanRecord` ask for a default that is already taken.
 */
async function releaseDefaultPlan(
  deps: ApplyMonetizationConfigDeps,
  projectId: string,
  planId: string
): Promise<Result<{ state: "ok"; released: Plan | null } | ApplyFailure, FetchError>> {
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
  if (!holder || holder.id === planId) return Ok({ state: "ok", released: null })

  const released = await deps.services.plans.updatePlanRecord({
    projectId,
    id: holder.id,
    defaultPlan: false,
    // updatePlanRecord rewrites both exclusivity flags on every call, so the one
    // it was not asked about has to be handed back to it.
    enterprisePlan: holder.enterprisePlan ?? false,
  })
  if (released.err) return Err(released.err)
  if (released.val.state === "plan_not_found") {
    return Ok(writeFailure("plan_not_found", { planSlug: holder.slug }))
  }
  if (released.val.state !== "ok") {
    return Err(
      new FetchError({
        message: `could not release the default plan from "${holder.slug}": ${released.val.state}`,
        // This call asks for `defaultPlan: false`, so neither default conflict
        // can fire and the only state left is enterprise_plan_exists: the
        // project already holds two enterprise plans. The service picks between
        // them with an unordered findFirst, so re-running lands nowhere new.
        retry: false,
      })
    )
  }

  return Ok({ state: "ok", released: released.val.plan })
}

/**
 * Reads every declared feature once, and rejects an incompatible slug before
 * anything at all has been written.
 */
async function resolveFeatures(
  { deps, projectId, caches }: MaterializeContext,
  config: MonetizationConfig
): Promise<Result<{ state: "ok"; pending: PendingFeature[] } | ApplyFailure, FetchError>> {
  const pending: PendingFeature[] = []

  for (const declared of config.features) {
    const existing = await deps.services.features.getFeatureBySlug({
      projectId,
      slug: declared.slug,
    })
    if (existing.err) return Err(existing.err)

    if (!existing.val) {
      pending.push({ declared, existing: null })
      continue
    }

    const stored = existing.val.unitOfMeasure ?? "units"
    if (declared.unitOfMeasure !== undefined && declared.unitOfMeasure !== stored) {
      return Ok({
        state: "slug_conflict",
        slug: declared.slug,
        message: `Feature "${declared.slug}" already exists in this project measured in "${stored}", not "${declared.unitOfMeasure}". Use another slug, or keep the existing unit`,
      })
    }

    caches.features.set(declared.slug, existing.val)
    pending.push({ declared, existing: existing.val })
  }

  return Ok({ state: "ok", pending })
}

/** Creates the features that are missing and relabels the ones that drifted. */
async function writeFeatures(
  { deps, projectId, caches }: MaterializeContext,
  pending: PendingFeature[]
): Promise<Result<{ state: "ok" } | ApplyFailure, FetchError>> {
  for (const { declared, existing } of pending) {
    const description = declared.description ?? ""

    if (!existing) {
      const created = await deps.services.features.createFeatureRecord({
        projectId,
        slug: declared.slug,
        title: declared.title,
        description,
        unitOfMeasure: declared.unitOfMeasure,
      })
      if (created.err) return Err(created.err)

      caches.features.set(declared.slug, created.val)
      continue
    }

    if (existing.title === declared.title && (existing.description ?? "") === description) continue

    const updated = await deps.services.features.updateFeatureRecord({
      projectId,
      id: existing.id,
      title: declared.title,
      description,
      // updateFeatureRecord writes `unitOfMeasure ?? ""`, so the current value
      // has to be handed back or the unit is wiped. The read pass already proved
      // the document agrees with it.
      unitOfMeasure: existing.unitOfMeasure ?? "units",
      hasMeterConfig: false,
    })
    if (updated.err) return Err(updated.err)
    if (updated.val.state !== "ok") {
      return Ok(writeFailure("feature_not_found", { featureSlug: declared.slug }))
    }

    caches.features.set(declared.slug, updated.val.feature)
  }

  return Ok({ state: "ok" })
}

/** Wide-event accumulator, emitted on every exit including the failing ones. */
type ApplyTrace = {
  plans: Array<{ slug: string; planVersionId: string; status: string; configHash: string }>
  created: number
  resumed: number
  unchanged: number
  published: number
  staleDrafts: number
  stoppedAt?: string
}

async function runApply(
  deps: ApplyMonetizationConfigDeps,
  { projectId, config }: { projectId: string; config: MonetizationConfig },
  trace: ApplyTrace
): Promise<Result<ApplyMonetizationConfigOutput, FetchError>> {
  const caches: PlanTemplateMaterializeCaches = {
    features: new Map(),
    events: new Map(),
    planVersionFeatureSlugs: new Map(),
  }
  const context: MaterializeContext = { deps, projectId, caches }

  const features = await resolveFeatures(context, config)
  if (features.err) return Err(features.err)
  if (features.val.state !== "ok") return Ok(features.val)

  // Events before features only because a meter points at an event, and the
  // event has to exist before any plan version snapshots it.
  for (const declared of config.events) {
    const event = await getOrCreateEvent(context, {
      slug: declared.slug,
      name: declared.name,
      availableProperties: declared.availableProperties ?? [],
    })
    if (event.err) return Err(event.err)
  }

  const written = await writeFeatures(context, features.val.pending)
  if (written.err) return Err(written.err)
  if (written.val.state !== "ok") return Ok(written.val)

  const planRows = new Map<string, Plan>()

  for (const plan of config.plans) {
    trace.stoppedAt = plan.slug
    const row = await getOrCreatePlan(context, {
      slug: plan.slug,
      title: plan.title,
      description: plan.description ?? "",
    })
    if (row.err) return Err(row.err)
    planRows.set(plan.slug, row.val)
  }

  for (const plan of config.plans) {
    trace.stoppedAt = plan.slug
    const row = planRows.get(plan.slug)
    if (!row) return Ok(unresolved(plan.slug, `Plan "${plan.slug}" was not resolved`))

    const description = plan.description ?? ""
    const defaultPlan = plan.defaultPlan === true
    // A plan the document does not name as default is not demoted here: only one
    // plan can hold the flag, and releaseDefaultPlan takes it immediately before
    // handing it over. Demoting in this loop would open a window with no default
    // plan at all, spanning every plan in between.
    const nextDefaultPlan = defaultPlan || (row.defaultPlan ?? false)

    if (
      row.title === plan.title &&
      (row.description ?? "") === description &&
      (row.defaultPlan ?? false) === nextDefaultPlan
    ) {
      continue
    }

    if (defaultPlan) {
      const released = await releaseDefaultPlan(deps, projectId, row.id)
      if (released.err) return Err(released.err)
      if (released.val.state !== "ok") return Ok(released.val)

      // The row that just lost the flag may be a plan further down this
      // document. Its snapshot here was read before the release and still claims
      // the flag, and `nextDefaultPlan` would then ask for a default that is
      // already taken — which is exactly what updatePlanRecord refuses.
      const demoted = released.val.released
      if (demoted) {
        for (const [slug, candidate] of planRows) {
          if (candidate.id === demoted.id) planRows.set(slug, demoted)
        }
      }
    }

    const updated = await deps.services.plans.updatePlanRecord({
      projectId,
      id: row.id,
      title: plan.title,
      description,
      defaultPlan: nextDefaultPlan,
      // Handed back rather than cleared: a plan being both default and
      // enterprise is a conflict the plan service already names, and quietly
      // demoting an enterprise plan is not this document's call to make.
      enterprisePlan: row.enterprisePlan ?? false,
    })
    if (updated.err) return Err(updated.err)
    if (
      updated.val.state === "plan_not_found" ||
      updated.val.state === "default_enterprise_conflict"
    ) {
      return Ok(writeFailure(updated.val.state, { planSlug: plan.slug }))
    }
    if (updated.val.state !== "ok") {
      return Err(
        new FetchError({
          message: `could not update plan "${plan.slug}": ${updated.val.state}`,
          // default_plan_exists means another writer took the flag between the
          // release and this write, and the same document sent again converges.
          // enterprise_plan_exists means the project already holds two
          // enterprise plans; the service picks between them with an unordered
          // findFirst, so no number of retries settles it.
          retry: updated.val.state === "default_plan_exists",
        })
      )
    }

    planRows.set(plan.slug, updated.val.plan)
  }

  const plans: MonetizationPlanOutcome[] = []
  const staleDrafts: MonetizationStaleDraft[] = []
  const resolvedPlanVersions: Record<string, string> = {}

  for (const plan of config.plans) {
    trace.stoppedAt = plan.slug
    const planRow = planRows.get(plan.slug)
    if (!planRow) return Ok(unresolved(plan.slug, `Plan "${plan.slug}" was not resolved`))

    const resolved = await resolvePlanDraft(context, { plan, planRow })
    if (resolved.err) return Err(resolved.err)
    if (resolved.val.state !== "ok") return Ok(resolved.val)

    const { outcome, origin, configHash } = resolved.val
    plans.push(outcome)
    staleDrafts.push(...resolved.val.staleDrafts)
    resolvedPlanVersions[plan.slug] = outcome.planVersionId
    trace[origin] += 1
    trace.plans.push({ ...outcome, configHash })
  }

  trace.stoppedAt = undefined
  trace.staleDrafts = staleDrafts.length

  return Ok({
    state: "ok",
    plans,
    staleDrafts,
    integrationContract: buildIntegrationContract(config, resolvedPlanVersions),
  })
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

  const trace: ApplyTrace = {
    plans: [],
    created: 0,
    resumed: 0,
    unchanged: 0,
    published: 0,
    staleDrafts: 0,
  }
  const result = await runApply(deps, { projectId, config }, trace)

  // One event on every exit. The whole recovery story here is "send the same
  // document again", so the run that stopped early is the one worth reading.
  // `created` counts fresh drafts and `resumed` counts half-materialized ones
  // finished in place; both are reported to the caller as "created".
  deps.logger.info("monetization configuration applied", {
    projectId,
    outcome: result.err ? "error" : result.val.state,
    ...(result.err ? { error: result.err.message } : {}),
    ...trace,
  })

  return result
}
