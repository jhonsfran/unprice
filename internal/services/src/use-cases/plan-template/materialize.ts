import type { Database } from "@unprice/db"
import { slugify } from "@unprice/db/utils"
import type {
  AggregationMethod,
  BillingInterval,
  ConfigFeatureVersionType,
  Currency,
  Event,
  Feature,
  MeterConfig,
  Plan,
  PlanVersion,
  PlanVersionFeature,
  ResetConfig,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import * as currencies from "dinero.js/currencies"
import type { ServiceContext } from "../../context"
import { createPlan } from "../plan/create"
import {
  BASE_FEE_FEATURE,
  CREDITS_FEATURE,
  DEFAULT_FEATURE_METADATA,
  ONBOARDING_USAGE_EVENT_NAME,
  ONBOARDING_USAGE_EVENT_SLUG,
  SEAT_FEATURE,
  type TemplatePlan,
} from "./template-data"

const AGGREGATION_METHODS_WITHOUT_FIELD = new Set<AggregationMethod>(["count"])

export type PlanTemplateMaterializeDeps = {
  services: Pick<ServiceContext, "plans" | "features" | "events">
  db: Database
  logger: Logger
}

export type PlanTemplateMaterializeCaches = {
  features: Map<string, Feature>
  events: Map<string, Event>
  planVersionFeatureSlugs: Map<string, Set<string>>
}

export type MaterializeContext = {
  deps: PlanTemplateMaterializeDeps
  projectId: string
  caches: PlanTemplateMaterializeCaches
}

/**
 * The minimum a feature has to describe for `getOrCreateFeature` to resolve it.
 * `TemplateFeature` and the monetization document's feature both satisfy it.
 */
export type MaterializableFeature = {
  slug: string
  title: string
  description?: Feature["description"]
  unitOfMeasure?: Feature["unitOfMeasure"]
}

type TemplatePlanVersion = PlanVersion & {
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
}

type PlanVersionFeatureFailureState =
  | "plan_version_not_found"
  | "plan_version_published"
  | "feature_not_found"
  | "usage_meter_config_required"
  | "invalid_reset_config"

type MaterializePlanVersionFeaturesOutput =
  | { state: "ok" }
  | { state: PlanVersionFeatureFailureState }

export function toDineroPrice(amount: string, currency: Currency) {
  const currencyConfig = currencies[currency]
  const precision = amount.split(".")[1]?.length ?? currencyConfig.exponent
  const amountNum = Math.round(Number(amount) * 10 ** precision)

  return {
    dinero: { amount: amountNum, currency: currencyConfig, scale: precision },
    displayAmount: amount,
  }
}

function featureMetadata(overrides: { hidden?: boolean }): NonNullable<
  PlanVersionFeature["metadata"]
> {
  return { ...DEFAULT_FEATURE_METADATA, ...overrides }
}

function hasTemplateVersionTags(planVersion: PlanVersion, tags: string[]) {
  const currentTags = planVersion.tags ?? []
  return tags.every((tag) => currentTags.includes(tag))
}

export function isTemplatePlanVersionComplete(
  featureSlugs: ReadonlySet<string>,
  expectedFeatureSlugs: ReadonlySet<string>
) {
  return Array.from(expectedFeatureSlugs).every((slug) => featureSlugs.has(slug))
}

export async function getOrCreatePlan(
  { deps, projectId }: MaterializeContext,
  plan: TemplatePlan["plan"]
): Promise<Result<Plan, FetchError>> {
  const existing = await deps.services.plans.getPlanBySlug({ projectId, slug: plan.slug })
  if (existing.err) return Err(existing.err)
  if (existing.val) return Ok(existing.val)

  return createPlan(
    { services: deps.services, db: deps.db, logger: deps.logger },
    {
      projectId,
      input: {
        title: plan.title,
        slug: plan.slug,
        description: plan.description,
        defaultPlan: false,
      },
    }
  )
}

export async function getExistingTemplatePlanVersion(
  { deps, projectId }: MaterializeContext,
  {
    planId,
    tags,
    currency,
    paymentProvider,
    expectedFeatureSlugs,
  }: {
    planId: string
    tags: string[]
    currency: Currency
    paymentProvider: PlanVersion["paymentProvider"]
    expectedFeatureSlugs: ReadonlySet<string>
  }
): Promise<
  Result<
    {
      planVersion: TemplatePlanVersion
      featureSlugs: Set<string>
      complete: boolean
    } | null,
    FetchError
  >
> {
  const existingVersions = await wrapResult(
    deps.db.query.versions.findMany({
      with: { planFeatures: { with: { feature: true } } },
      where: (version, { and, eq }) =>
        and(eq(version.projectId, projectId), eq(version.planId, planId)),
    }),
    (error) =>
      new FetchError({
        message: `error checking existing template plan versions: ${error.message}`,
        retry: false,
      })
  )

  if (existingVersions.err) {
    deps.logger.error(existingVersions.err, {
      context: "error checking existing template plan versions",
      projectId,
      planId,
    })
    return Err(existingVersions.err)
  }

  const candidates = (existingVersions.val as TemplatePlanVersion[])
    .filter(
      (planVersion) =>
        planVersion.planId === planId &&
        planVersion.currency === currency &&
        planVersion.paymentProvider === paymentProvider &&
        hasTemplateVersionTags(planVersion, tags)
    )
    .map((planVersion) => {
      const featureSlugs = new Set(planVersion.planFeatures.map(({ feature }) => feature.slug))
      return {
        planVersion,
        featureSlugs,
        complete: isTemplatePlanVersionComplete(featureSlugs, expectedFeatureSlugs),
      }
    })
    .filter(({ complete, planVersion }) => complete || planVersion.status === "draft")
    .sort(
      (left, right) =>
        Number(right.complete) - Number(left.complete) ||
        (right.planVersion.createdAtM ?? 0) - (left.planVersion.createdAtM ?? 0)
    )

  return Ok(candidates[0] ?? null)
}

export async function createTemplatePlanVersion(
  { deps, projectId }: MaterializeContext,
  {
    planId,
    template,
    currency,
    paymentProvider,
    tags,
    configHash,
  }: {
    planId: string
    // Widened from `TemplatePlan` so the monetization document can supply the
    // same three fields. Everything else on a plan version is server policy and
    // stays hardcoded below, which is what makes the content hash meaningful:
    // two documents that hash the same describe the same version.
    template: {
      plan: Pick<TemplatePlan["plan"], "title" | "description">
      billingConfig: {
        name: string
        interval: BillingInterval
        intervalCount: number
      }
    }
    currency: Currency
    paymentProvider: PlanVersion["paymentProvider"]
    tags: string[]
    configHash?: string
  }
) {
  return deps.services.plans.createPlanVersionRecord({
    projectId,
    planId,
    title: template.plan.title,
    description: template.plan.description,
    currency,
    paymentProvider,
    paymentMethodRequired: true,
    whenToBill: "pay_in_advance",
    autoRenew: true,
    trialUnits: 0,
    collectionMethod: "charge_automatically",
    dueBehaviour: "cancel",
    gracePeriod: 0,
    tags,
    metadata: null,
    billingConfig: {
      name: template.billingConfig.name,
      billingInterval: template.billingConfig.interval,
      billingIntervalCount: template.billingConfig.intervalCount,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    },
    status: "draft",
    configHash,
  })
}

export async function getOrCreateFeature(
  { deps, projectId, caches }: MaterializeContext,
  feature: MaterializableFeature
): Promise<Result<Feature, FetchError>> {
  const cached = caches.features.get(feature.slug)
  if (cached) return Ok(cached)

  const existing = await deps.services.features.getFeatureBySlug({ projectId, slug: feature.slug })
  if (existing.err) return Err(existing.err)
  if (existing.val) {
    caches.features.set(feature.slug, existing.val)
    return Ok(existing.val)
  }

  const created = await deps.services.features.createFeatureRecord({
    projectId,
    title: feature.title,
    slug: feature.slug,
    description: feature.description,
    unitOfMeasure: feature.unitOfMeasure,
  })
  if (created.err) return Err(created.err)

  caches.features.set(feature.slug, created.val)
  return Ok(created.val)
}

function mergeProperties(current: string[] | null | undefined, next: string[]) {
  return Array.from(new Set([...(current ?? []), ...next]))
}

export async function ensureEventProperties(
  { deps, projectId, caches }: MaterializeContext,
  event: Event,
  properties: string[]
): Promise<Result<Event, FetchError>> {
  const mergedProperties = mergeProperties(event.availableProperties, properties)
  if (mergedProperties.length === (event.availableProperties ?? []).length) {
    caches.events.set(event.slug, event)
    return Ok(event)
  }

  const updated = await deps.services.events.updateEvent({
    projectId,
    id: event.id,
    name: event.name,
    availableProperties: mergedProperties,
    hasAvailableProperties: true,
  })
  if (updated.err) return Err(updated.err)
  if (updated.val.state === "not_found") {
    return Err(
      new FetchError({
        message: "Template event was not found while updating meter properties",
        retry: false,
      })
    )
  }

  caches.events.set(event.slug, updated.val.event)
  return Ok(updated.val.event)
}

export async function getOrCreateEvent(
  context: MaterializeContext,
  { slug, name, availableProperties }: { slug: string; name: string; availableProperties: string[] }
): Promise<Result<Event, FetchError>> {
  const normalizedProperties = Array.from(new Set(availableProperties.filter(Boolean)))
  const cached = context.caches.events.get(slug)
  if (cached) return ensureEventProperties(context, cached, normalizedProperties)

  const listed = await context.deps.services.events.listEventsByProject({
    projectId: context.projectId,
  })
  if (listed.err) return Err(listed.err)

  const existing = listed.val.find((event) => event.slug === slug)
  if (existing) return ensureEventProperties(context, existing, normalizedProperties)

  const created = await context.deps.services.events.createEvent({
    projectId: context.projectId,
    name,
    slug,
    availableProperties: normalizedProperties,
  })
  if (created.err) return Err(created.err)

  context.caches.events.set(slug, created.val)
  return Ok(created.val)
}

async function buildMeterConfig(
  context: MaterializeContext,
  {
    featureSlug,
    aggregationMethod,
    eventSlug = ONBOARDING_USAGE_EVENT_SLUG,
    eventName = ONBOARDING_USAGE_EVENT_NAME,
  }: {
    featureSlug: string
    aggregationMethod: AggregationMethod
    eventSlug?: string
    eventName?: string
  }
): Promise<Result<MeterConfig, FetchError>> {
  const aggregationField = AGGREGATION_METHODS_WITHOUT_FIELD.has(aggregationMethod)
    ? undefined
    : slugify(featureSlug).replace(/-/g, "_")
  const event = await getOrCreateEvent(context, {
    slug: eventSlug,
    name: eventName,
    availableProperties: aggregationField ? [aggregationField] : [],
  })
  if (event.err) return Err(event.err)

  return Ok({
    eventId: event.val.id,
    eventSlug: event.val.slug,
    aggregationMethod,
    ...(aggregationField ? { aggregationField } : {}),
  })
}

export async function getOrCreatePlanVersionFeature(
  { deps, projectId, caches }: MaterializeContext,
  {
    planVersion,
    feature,
    featureType,
    config,
    order,
    defaultQuantity = 1,
    limit,
    resetConfig,
    metadata,
    meterConfig,
  }: {
    planVersion: PlanVersion
    feature: Feature
    featureType: PlanVersionFeature["featureType"]
    config: ConfigFeatureVersionType
    order: number
    defaultQuantity?: number
    limit?: number
    resetConfig?: ResetConfig
    metadata?: PlanVersionFeature["metadata"]
    meterConfig?: MeterConfig
  }
): Promise<Result<MaterializePlanVersionFeaturesOutput, FetchError>> {
  const existingSlugs = caches.planVersionFeatureSlugs.get(planVersion.id) ?? new Set<string>()
  caches.planVersionFeatureSlugs.set(planVersion.id, existingSlugs)
  if (existingSlugs.has(feature.slug)) return Ok({ state: "ok" })

  const created = await deps.services.plans.createPlanVersionFeatureRecord({
    projectId,
    planVersionId: planVersion.id,
    featureId: feature.id,
    featureType,
    config,
    order,
    billingConfig: planVersion.billingConfig,
    resetConfig: resetConfig ?? {
      name: planVersion.billingConfig.name,
      resetInterval: planVersion.billingConfig.billingInterval,
      resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
      resetAnchor: planVersion.billingConfig.billingAnchor,
      planType: planVersion.billingConfig.planType,
    },
    defaultQuantity,
    limit,
    metadata,
    meterConfig,
    hasMeterConfigOverride: Boolean(meterConfig),
  })
  if (created.err) return Err(created.err)
  if (created.val.state !== "ok") return Ok({ state: created.val.state })

  existingSlugs.add(feature.slug)
  return Ok({ state: "ok" })
}

async function materializeFeature(
  context: MaterializeContext,
  input: Parameters<typeof getOrCreatePlanVersionFeature>[1]
) {
  const result = await getOrCreatePlanVersionFeature(context, input)
  if (result.err) return Err(result.err)
  return Ok(result.val)
}

export async function materializeTemplatePlanFeatures(
  context: MaterializeContext,
  {
    template,
    planVersion,
    currency,
  }: { template: TemplatePlan; planVersion: PlanVersion; currency: Currency }
): Promise<Result<MaterializePlanVersionFeaturesOutput, FetchError>> {
  const baseFeeFeature = await getOrCreateFeature(context, BASE_FEE_FEATURE)
  if (baseFeeFeature.err) return Err(baseFeeFeature.err)
  const baseFee = await materializeFeature(context, {
    planVersion,
    feature: baseFeeFeature.val,
    featureType: "flat",
    config: { price: toDineroPrice(template.baseFee, currency) },
    order: 1024,
    metadata: featureMetadata({ hidden: true }),
  })
  if (baseFee.err || baseFee.val.state !== "ok") return baseFee

  const needsSeatFeature = Boolean(template.seatPack || template.usage.slug === SEAT_FEATURE.slug)
  const seatFeature = needsSeatFeature ? await getOrCreateFeature(context, SEAT_FEATURE) : null
  if (seatFeature?.err) return Err(seatFeature.err)

  if (template.seatPack && seatFeature?.val) {
    const seat = await materializeFeature(context, {
      planVersion,
      feature: seatFeature.val,
      featureType: "package",
      config: {
        price: toDineroPrice(template.seatPack.price, currency),
        units: template.seatPack.units,
      },
      order: 2048,
      limit: template.seatPack.units,
    })
    if (seat.err || seat.val.state !== "ok") return seat
  }

  for (const [index, flatFeatureTemplate] of template.flatFeatures.entries()) {
    const flatFeature = await getOrCreateFeature(context, flatFeatureTemplate)
    if (flatFeature.err) return Err(flatFeature.err)
    const flat = await materializeFeature(context, {
      planVersion,
      feature: flatFeature.val,
      featureType: "flat",
      config: { price: toDineroPrice("0", currency) },
      order: 3072 + index * 1024,
    })
    if (flat.err || flat.val.state !== "ok") return flat
  }

  const usageFeature =
    seatFeature?.val && template.usage.slug === SEAT_FEATURE.slug
      ? Ok(seatFeature.val)
      : await getOrCreateFeature(context, template.usage)
  if (usageFeature.err) return Err(usageFeature.err)

  const usageAggregationMethod = template.usage.config.aggregationMethod ?? "sum"
  const usageMeterConfig = await buildMeterConfig(context, {
    featureSlug: usageFeature.val.slug,
    aggregationMethod: usageAggregationMethod,
    eventSlug: template.usage.eventSlug,
    eventName: template.usage.eventName,
  })
  if (usageMeterConfig.err) return Err(usageMeterConfig.err)

  const usageConfig: ConfigFeatureVersionType =
    template.usage.config.mode === "unit"
      ? {
          usageMode: "unit",
          price: toDineroPrice(template.usage.config.price, currency),
        }
      : {
          usageMode: "tier",
          tierMode: "graduated",
          tiers: template.usage.config.tiers.map((tier) => ({
            firstUnit: tier.firstUnit,
            lastUnit: tier.lastUnit,
            unitPrice: toDineroPrice(tier.unitPrice, currency),
            flatPrice: toDineroPrice("0", currency),
          })),
        }
  const usage = await materializeFeature(context, {
    planVersion,
    feature: usageFeature.val,
    featureType: "usage",
    config: usageConfig,
    order: 6144,
    limit: template.usage.config.limit,
    meterConfig: usageMeterConfig.val,
  })
  if (usage.err || usage.val.state !== "ok") return usage

  const creditsFeature = await getOrCreateFeature(context, CREDITS_FEATURE)
  if (creditsFeature.err) return Err(creditsFeature.err)
  const creditsMeterConfig = await buildMeterConfig(context, {
    featureSlug: creditsFeature.val.slug,
    aggregationMethod: "sum",
  })
  if (creditsMeterConfig.err) return Err(creditsMeterConfig.err)
  return materializeFeature(context, {
    planVersion,
    feature: creditsFeature.val,
    featureType: "usage",
    config: {
      usageMode: "tier",
      tierMode: "graduated",
      tiers: [
        {
          firstUnit: 1,
          lastUnit: 1000,
          unitPrice: toDineroPrice("0.01", currency),
          flatPrice: toDineroPrice("0", currency),
        },
        {
          firstUnit: 1001,
          lastUnit: 10000,
          unitPrice: toDineroPrice("0.0075", currency),
          flatPrice: toDineroPrice("0", currency),
        },
        {
          firstUnit: 10001,
          lastUnit: null,
          unitPrice: toDineroPrice("0.005", currency),
          flatPrice: toDineroPrice("0", currency),
        },
      ],
    },
    order: 7168,
    limit: 10000,
    resetConfig: {
      name: "daily",
      resetInterval: "day",
      resetIntervalCount: 1,
      resetAnchor: "dayOfCreation",
      planType: planVersion.billingConfig.planType,
    },
    meterConfig: creditsMeterConfig.val,
  })
}
