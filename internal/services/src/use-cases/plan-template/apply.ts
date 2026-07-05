import type { Database } from "@unprice/db"
import { slugify } from "@unprice/db/utils"
import {
  type AggregationMethod,
  type ConfigFeatureVersionType,
  type Currency,
  type Event,
  type Feature,
  type MeterConfig,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  type ResetConfig,
  currencySchema,
  paymentProviderSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import * as currencies from "dinero.js/currencies"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { publishPlanVersionFlow } from "../plan-version/publish-shared"
import { createPlanFlow } from "../plan/create-shared"

const ONBOARDING_TEMPLATE_KEY = "saas_onboarding"
const ONBOARDING_USAGE_EVENT_SLUG = "workflow_runs"
const ONBOARDING_USAGE_EVENT_NAME = "Workflow Runs"
const AGGREGATION_METHODS_WITHOUT_FIELD = new Set<AggregationMethod>(["count"])
const TEMPLATE_SOURCE_TAG_PREFIX = "template:"
const TEMPLATE_PLAN_TAG_PREFIX = "template-plan:"

export const planTemplateKeySchema = z.enum([ONBOARDING_TEMPLATE_KEY])

export const applyPlanTemplateRequestSchema = z.object({
  template: planTemplateKeySchema.default(ONBOARDING_TEMPLATE_KEY),
  currency: currencySchema.default("USD"),
  paymentProvider: paymentProviderSchema.default("sandbox"),
  publish: z.boolean().default(false),
})

export const applyPlanTemplateInputSchema = applyPlanTemplateRequestSchema.extend({
  projectId: z.string().min(1),
  workspaceUnPriceCustomerId: z.string().min(1),
})

export const appliedPlanTemplateSchema = z.object({
  key: z.string(),
  label: z.string(),
  planId: z.string(),
  planVersionId: z.string(),
})

export const applyPlanTemplateOutputSchema = z.object({
  state: z.literal("ok"),
  primaryPlanVersionId: z.string(),
  appliedTemplates: z.array(appliedPlanTemplateSchema),
})

export type ApplyPlanTemplateRequest = z.input<typeof applyPlanTemplateRequestSchema>
export type ApplyPlanTemplateInput = z.input<typeof applyPlanTemplateInputSchema>
export type ApplyPlanTemplateOutput = z.infer<typeof applyPlanTemplateOutputSchema>

type ApplyPlanTemplateFailureState =
  | "plan_not_found"
  | "plan_version_not_found"
  | "plan_version_published"
  | "feature_not_found"
  | "usage_meter_config_required"
  | "invalid_reset_config"
  | "version_not_found"
  | "already_published"
  | "no_features"
  | "price_calculation_error"
  | "payment_provider_error"
  | "publish_error"

type ApplyPlanTemplateDeps = {
  services: Pick<ServiceContext, "plans" | "features" | "events" | "customers">
  db: Database
  logger: Logger
  userId: string
}

type UsageTier = {
  firstUnit: number
  lastUnit: number | null
  unitPrice: string
}

type UsageConfig =
  | {
      mode: "unit"
      price: string
      limit?: number
      aggregationMethod?: "count" | "sum" | "latest"
    }
  | {
      mode: "tier"
      tiers: UsageTier[]
      limit?: number
      aggregationMethod?: "sum" | "latest"
    }

type TemplateFeature = {
  title: string
  slug: string
  description: string
  unitOfMeasure: string
}

type SeatPackConfig = {
  price: string
  units: number
}

type TemplatePlan = {
  key: string
  label: string
  plan: {
    title: string
    slug: string
    description: string
  }
  billingConfig: {
    name: string
    interval: "month" | "year"
    intervalCount: number
  }
  baseFee: string
  seatPack?: SeatPackConfig
  usage: TemplateFeature & {
    config: UsageConfig
  }
  flatFeatures: TemplateFeature[]
}

type TemplatePlanVersion = PlanVersion & {
  planFeatures: PlanVersionFeature[]
}

const BASE_FEE_FEATURE: TemplateFeature = {
  title: "Workflow Runtime Access",
  slug: "workflow-runtime-access",
  description: "Base access to the workflow runtime.",
  unitOfMeasure: "access",
}

const SEAT_FEATURE: TemplateFeature = {
  title: "Operator Seats",
  slug: "operator-seats",
  description: "Team seats for operating workflows.",
  unitOfMeasure: "seat",
}

const CREDITS_FEATURE: TemplateFeature = {
  title: "Credits",
  slug: "credits",
  description:
    "Metered credits consumed by workflow steps inside a budgeted run. Use this when one run can fan out into variable work.",
  unitOfMeasure: "credit",
}

const DEFAULT_FEATURE_METADATA = {
  realtime: false,
  notifyUsageThreshold: 95,
  overageStrategy: "none",
  blockCustomer: false,
  hidden: false,
} satisfies NonNullable<PlanVersionFeature["metadata"]>

const SAAS_ONBOARDING_TEMPLATE: TemplatePlan[] = [
  {
    key: "starter",
    label: "Starter",
    plan: {
      title: "Starter",
      slug: "starter",
      description: "Entry plan for one production workflow.",
    },
    billingConfig: {
      name: "monthly",
      interval: "month",
      intervalCount: 1,
    },
    baseFee: "49",
    seatPack: {
      price: "12",
      units: 5,
    },
    usage: {
      title: "Runs",
      slug: "runs",
      description:
        "Customer-triggered workflow executions. The workflow_runs event records each run in the request path.",
      unitOfMeasure: "run",
      config: {
        mode: "unit",
        price: "0.08",
        limit: 1000,
        aggregationMethod: "count",
      },
    },
    flatFeatures: [
      {
        title: "Run History",
        slug: "run-history",
        description: "Inspect recent budgeted workflow runs, usage evidence, and access decisions.",
        unitOfMeasure: "history",
      },
      {
        title: "Sandbox Environments",
        slug: "sandbox-environments",
        description: "Separate test environments for workflow experiments.",
        unitOfMeasure: "environment",
      },
    ],
  },
  {
    key: "pro",
    label: "Pro",
    plan: {
      title: "Pro",
      slug: "pro",
      description: "Higher-volume workflows with tiered compute pricing.",
    },
    billingConfig: {
      name: "monthly",
      interval: "month",
      intervalCount: 1,
    },
    baseFee: "149",
    seatPack: {
      price: "18",
      units: 10,
    },
    usage: {
      title: "Compute",
      slug: "compute",
      description:
        "Runtime seconds consumed while workflow executions are processed inside a budgeted run.",
      unitOfMeasure: "second",
      config: {
        mode: "tier",
        tiers: [
          { firstUnit: 1, lastUnit: 500000, unitPrice: "0.002" },
          { firstUnit: 500001, lastUnit: 2000000, unitPrice: "0.0015" },
          { firstUnit: 2000001, lastUnit: null, unitPrice: "0.001" },
        ],
      },
    },
    flatFeatures: [
      {
        title: "SAML SSO",
        slug: "saml-sso",
        description: "Single sign-on for the operator workspace.",
        unitOfMeasure: "sso",
      },
      {
        title: "Audit Trail",
        slug: "audit-trail",
        description: "Detailed workflow and access audit history.",
        unitOfMeasure: "log",
      },
    ],
  },
  {
    key: "enterprise",
    label: "Enterprise",
    plan: {
      title: "Enterprise",
      slug: "enterprise",
      description: "Annual plan for customer-critical automation.",
    },
    billingConfig: {
      name: "annual",
      interval: "year",
      intervalCount: 1,
    },
    baseFee: "2400",
    usage: {
      title: "Runs",
      slug: "runs",
      description:
        "Customer-triggered workflow executions with annual enterprise pricing. The workflow_runs event carries the workflow context.",
      unitOfMeasure: "run",
      config: {
        mode: "unit",
        price: "0.03",
        limit: 250000,
        aggregationMethod: "count",
      },
    },
    flatFeatures: [
      {
        title: "Private Deployment",
        slug: "private-deployment",
        description: "Run workflow automation in a dedicated deployment.",
        unitOfMeasure: "deployment",
      },
      {
        title: "Priority Incident Response",
        slug: "priority-incident-response",
        description: "Operational support for customer-critical workflow failures.",
        unitOfMeasure: "sla",
      },
    ],
  },
]

function toDineroPrice(amount: string, currency: Currency) {
  const currencyConfig = currencies[currency]
  const precision = amount.split(".")[1]?.length ?? currencyConfig.exponent
  const amountNum = Math.round(Number(amount) * 10 ** precision)

  return {
    dinero: {
      amount: amountNum,
      currency: currencyConfig,
      scale: precision,
    },
    displayAmount: amount,
  }
}

function toUsageAggregationField(featureSlug: string) {
  return slugify(featureSlug).replace(/-/g, "_")
}

function mergeProperties(current: string[] | null | undefined, next: string[]) {
  return Array.from(new Set([...(current ?? []), ...next]))
}

function featureMetadata(overrides: { hidden?: boolean }): NonNullable<
  PlanVersionFeature["metadata"]
> {
  return {
    ...DEFAULT_FEATURE_METADATA,
    ...overrides,
  }
}

function resolveTemplate(template: z.infer<typeof planTemplateKeySchema>) {
  switch (template) {
    case ONBOARDING_TEMPLATE_KEY:
      return SAAS_ONBOARDING_TEMPLATE
  }
}

function getTemplateVersionTags(templateKey: string, templatePlanKey: string) {
  return [
    `${TEMPLATE_SOURCE_TAG_PREFIX}${templateKey}`,
    `${TEMPLATE_PLAN_TAG_PREFIX}${templatePlanKey}`,
  ]
}

function hasTemplateVersionTags(planVersion: PlanVersion, tags: string[]) {
  const currentTags = planVersion.tags ?? []

  return tags.every((tag) => currentTags.includes(tag))
}

export async function applyPlanTemplate(
  deps: ApplyPlanTemplateDeps,
  rawInput: ApplyPlanTemplateInput
): Promise<Result<ApplyPlanTemplateOutput | { state: ApplyPlanTemplateFailureState }, FetchError>> {
  const input = applyPlanTemplateInputSchema.parse(rawInput)
  const templates = resolveTemplate(input.template)
  const featureCache = new Map<string, Feature>()
  const eventCache = new Map<string, Event>()

  deps.logger.set({
    business: {
      operation: "plan-template.apply",
      project_id: input.projectId,
    },
  })

  const getOrCreatePlan = async (plan: TemplatePlan["plan"]): Promise<Result<Plan, FetchError>> => {
    const existing = await deps.services.plans.getPlanBySlug({
      projectId: input.projectId,
      slug: plan.slug,
    })

    if (existing.err) {
      return Err(existing.err)
    }

    if (existing.val) {
      return Ok(existing.val)
    }

    return createPlanFlow(
      {
        services: deps.services,
        db: deps.db,
        logger: deps.logger,
      },
      {
        projectId: input.projectId,
        input: {
          title: plan.title,
          slug: plan.slug,
          description: plan.description,
          defaultPlan: false,
        },
      }
    )
  }

  const getExistingTemplatePlanVersion = async ({
    planId,
    tags,
  }: {
    planId: string
    tags: string[]
  }): Promise<Result<TemplatePlanVersion | null, FetchError>> => {
    const existingVersions = await wrapResult(
      deps.db.query.versions.findMany({
        with: {
          planFeatures: true,
        },
        where: (version, { and, eq }) =>
          and(eq(version.projectId, input.projectId), eq(version.planId, planId)),
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
        projectId: input.projectId,
        planId,
      })

      return Err(existingVersions.err)
    }

    const completedVersions = (existingVersions.val as TemplatePlanVersion[])
      .filter(
        (planVersion) =>
          planVersion.planId === planId &&
          planVersion.currency === input.currency &&
          planVersion.paymentProvider === input.paymentProvider &&
          hasTemplateVersionTags(planVersion, tags) &&
          planVersion.planFeatures.length > 0
      )
      .sort((left, right) => (right.createdAtM ?? 0) - (left.createdAtM ?? 0))

    return Ok(completedVersions[0] ?? null)
  }

  const getOrCreateFeature = async (
    feature: TemplateFeature
  ): Promise<Result<Feature, FetchError>> => {
    const cached = featureCache.get(feature.slug)
    if (cached) {
      return Ok(cached)
    }

    const existing = await deps.services.features.getFeatureBySlug({
      projectId: input.projectId,
      slug: feature.slug,
    })

    if (existing.err) {
      return Err(existing.err)
    }

    if (existing.val) {
      featureCache.set(feature.slug, existing.val)
      return Ok(existing.val)
    }

    const created = await deps.services.features.createFeatureRecord({
      projectId: input.projectId,
      title: feature.title,
      slug: feature.slug,
      description: feature.description,
      unitOfMeasure: feature.unitOfMeasure,
    })

    if (created.err) {
      return Err(created.err)
    }

    featureCache.set(feature.slug, created.val)
    return Ok(created.val)
  }

  const getOrCreateEvent = async ({
    slug,
    name,
    availableProperties,
  }: {
    slug: string
    name: string
    availableProperties: string[]
  }): Promise<Result<Event, FetchError>> => {
    const normalizedProperties = Array.from(new Set(availableProperties.filter(Boolean)))
    const cached = eventCache.get(slug)

    if (cached) {
      const mergedProperties = mergeProperties(cached.availableProperties, normalizedProperties)

      if (mergedProperties.length === (cached.availableProperties ?? []).length) {
        return Ok(cached)
      }

      const updated = await deps.services.events.updateEvent({
        projectId: input.projectId,
        id: cached.id,
        name: cached.name,
        availableProperties: mergedProperties,
        hasAvailableProperties: true,
      })

      if (updated.err) {
        return Err(updated.err)
      }

      if (updated.val.state === "not_found") {
        return Err(
          new FetchError({
            message: "Template event was not found while updating meter properties",
            retry: false,
          })
        )
      }

      eventCache.set(slug, updated.val.event)
      return Ok(updated.val.event)
    }

    const listed = await deps.services.events.listEventsByProject({
      projectId: input.projectId,
    })

    if (listed.err) {
      return Err(listed.err)
    }

    const existing = listed.val.find((event) => event.slug === slug)

    if (existing) {
      const mergedProperties = mergeProperties(existing.availableProperties, normalizedProperties)

      if (mergedProperties.length === (existing.availableProperties ?? []).length) {
        eventCache.set(slug, existing)
        return Ok(existing)
      }

      const updated = await deps.services.events.updateEvent({
        projectId: input.projectId,
        id: existing.id,
        name: existing.name,
        availableProperties: mergedProperties,
        hasAvailableProperties: true,
      })

      if (updated.err) {
        return Err(updated.err)
      }

      if (updated.val.state === "not_found") {
        return Err(
          new FetchError({
            message: "Template event was not found while updating meter properties",
            retry: false,
          })
        )
      }

      eventCache.set(slug, updated.val.event)
      return Ok(updated.val.event)
    }

    const created = await deps.services.events.createEvent({
      projectId: input.projectId,
      name,
      slug,
      availableProperties: normalizedProperties,
    })

    if (created.err) {
      return Err(created.err)
    }

    eventCache.set(slug, created.val)
    return Ok(created.val)
  }

  const buildMeterConfig = async ({
    featureSlug,
    aggregationMethod,
  }: {
    featureSlug: string
    aggregationMethod: AggregationMethod
  }): Promise<Result<MeterConfig, FetchError>> => {
    const aggregationField = AGGREGATION_METHODS_WITHOUT_FIELD.has(aggregationMethod)
      ? undefined
      : toUsageAggregationField(featureSlug)

    const event = await getOrCreateEvent({
      slug: ONBOARDING_USAGE_EVENT_SLUG,
      name: ONBOARDING_USAGE_EVENT_NAME,
      availableProperties: aggregationField ? [aggregationField] : [],
    })

    if (event.err) {
      return Err(event.err)
    }

    return Ok({
      eventId: event.val.id,
      eventSlug: event.val.slug,
      aggregationMethod,
      ...(aggregationField ? { aggregationField } : {}),
    })
  }

  const createPlanVersionFeature = async ({
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
    featureType: "flat" | "package" | "usage"
    config: ConfigFeatureVersionType
    order: number
    defaultQuantity?: number
    limit?: number
    resetConfig?: ResetConfig
    metadata?: PlanVersionFeature["metadata"]
    meterConfig?: MeterConfig
  }): Promise<
    Result<
      | { state: "ok" }
      | {
          state:
            | "plan_version_not_found"
            | "plan_version_published"
            | "feature_not_found"
            | "usage_meter_config_required"
            | "invalid_reset_config"
        },
      FetchError
    >
  > => {
    const created = await deps.services.plans.createPlanVersionFeatureRecord({
      projectId: input.projectId,
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

    if (created.err) {
      return Err(created.err)
    }

    if (created.val.state !== "ok") {
      return Ok({
        state: created.val.state,
      })
    }

    return Ok({
      state: "ok",
    })
  }

  const baseFeeFeature = await getOrCreateFeature(BASE_FEE_FEATURE)
  if (baseFeeFeature.err) {
    return Err(baseFeeFeature.err)
  }

  const creditsFeature = await getOrCreateFeature(CREDITS_FEATURE)
  if (creditsFeature.err) {
    return Err(creditsFeature.err)
  }

  const appliedTemplates: ApplyPlanTemplateOutput["appliedTemplates"] = []

  for (const template of templates) {
    const plan = await getOrCreatePlan(template.plan)
    if (plan.err) {
      return Err(plan.err)
    }

    const templateTags = getTemplateVersionTags(input.template, template.key)
    const existingPlanVersion = await getExistingTemplatePlanVersion({
      planId: plan.val.id,
      tags: templateTags,
    })

    if (existingPlanVersion.err) {
      return Err(existingPlanVersion.err)
    }

    if (existingPlanVersion.val) {
      if (input.publish && existingPlanVersion.val.status !== "published") {
        const published = await publishPlanVersionFlow(
          {
            services: deps.services,
            db: deps.db,
            logger: deps.logger,
            userId: deps.userId,
          },
          {
            id: existingPlanVersion.val.id,
            projectId: input.projectId,
            workspaceUnPriceCustomerId: input.workspaceUnPriceCustomerId,
          }
        )

        if (published.err) {
          return Err(published.err)
        }

        if (published.val.state !== "ok" && published.val.state !== "already_published") {
          return Ok({
            state: published.val.state,
          })
        }
      }

      appliedTemplates.push({
        key: template.key,
        label: template.label,
        planId: plan.val.id,
        planVersionId: existingPlanVersion.val.id,
      })
      continue
    }

    const planVersionResult = await deps.services.plans.createPlanVersionRecord({
      projectId: input.projectId,
      planId: plan.val.id,
      title: template.plan.title,
      description: template.plan.description,
      currency: input.currency,
      paymentProvider: input.paymentProvider,
      paymentMethodRequired: true,
      whenToBill: "pay_in_advance",
      autoRenew: true,
      trialUnits: 0,
      collectionMethod: "charge_automatically",
      dueBehaviour: "cancel",
      gracePeriod: 0,
      tags: templateTags,
      metadata: null,
      billingConfig: {
        name: template.billingConfig.name,
        billingInterval: template.billingConfig.interval,
        billingIntervalCount: template.billingConfig.intervalCount,
        billingAnchor: "dayOfCreation",
        planType: "recurring",
      },
      status: "draft",
    })

    if (planVersionResult.err) {
      return Err(planVersionResult.err)
    }

    if (planVersionResult.val.state !== "ok") {
      return Ok({
        state: planVersionResult.val.state,
      })
    }

    const planVersion = planVersionResult.val.planVersion

    const baseFeeFeatureResult = await createPlanVersionFeature({
      planVersion,
      feature: baseFeeFeature.val,
      featureType: "flat",
      config: {
        price: toDineroPrice(template.baseFee, input.currency),
      },
      order: 1024,
      defaultQuantity: 1,
      metadata: featureMetadata({
        hidden: true,
      }),
    })

    if (baseFeeFeatureResult.err) {
      return Err(baseFeeFeatureResult.err)
    }

    if (baseFeeFeatureResult.val.state !== "ok") {
      return Ok(baseFeeFeatureResult.val)
    }

    const needsSeatFeature = Boolean(template.seatPack || template.usage.slug === SEAT_FEATURE.slug)
    const seatFeature = needsSeatFeature ? await getOrCreateFeature(SEAT_FEATURE) : null
    if (seatFeature?.err) {
      return Err(seatFeature.err)
    }

    if (template.seatPack && seatFeature?.val) {
      const seatFeatureResult = await createPlanVersionFeature({
        planVersion,
        feature: seatFeature.val,
        featureType: "package",
        config: {
          price: toDineroPrice(template.seatPack.price, input.currency),
          units: template.seatPack.units,
        },
        order: 2048,
        defaultQuantity: 1,
        limit: template.seatPack.units,
      })

      if (seatFeatureResult.err) {
        return Err(seatFeatureResult.err)
      }

      if (seatFeatureResult.val.state !== "ok") {
        return Ok(seatFeatureResult.val)
      }
    }

    for (const [index, flatFeatureTemplate] of template.flatFeatures.entries()) {
      const flatFeature = await getOrCreateFeature(flatFeatureTemplate)
      if (flatFeature.err) {
        return Err(flatFeature.err)
      }

      const flatFeatureResult = await createPlanVersionFeature({
        planVersion,
        feature: flatFeature.val,
        featureType: "flat",
        config: {
          price: toDineroPrice("0", input.currency),
        },
        order: 3072 + index * 1024,
        defaultQuantity: 1,
      })

      if (flatFeatureResult.err) {
        return Err(flatFeatureResult.err)
      }

      if (flatFeatureResult.val.state !== "ok") {
        return Ok(flatFeatureResult.val)
      }
    }

    const usageFeature =
      seatFeature?.val && template.usage.slug === SEAT_FEATURE.slug
        ? Ok(seatFeature.val)
        : await getOrCreateFeature({
            title: template.usage.title,
            slug: template.usage.slug,
            description: template.usage.description,
            unitOfMeasure: template.usage.unitOfMeasure,
          })

    if (usageFeature.err) {
      return Err(usageFeature.err)
    }

    const usageAggregationMethod = template.usage.config.aggregationMethod ?? "sum"
    const usageMeterConfig = await buildMeterConfig({
      featureSlug: usageFeature.val.slug,
      aggregationMethod: usageAggregationMethod,
    })

    if (usageMeterConfig.err) {
      return Err(usageMeterConfig.err)
    }

    const usageConfig: ConfigFeatureVersionType =
      template.usage.config.mode === "unit"
        ? {
            usageMode: "unit",
            price: toDineroPrice(template.usage.config.price, input.currency),
          }
        : {
            usageMode: "tier",
            tierMode: "graduated",
            tiers: template.usage.config.tiers.map((tier) => ({
              firstUnit: tier.firstUnit,
              lastUnit: tier.lastUnit,
              unitPrice: toDineroPrice(tier.unitPrice, input.currency),
              flatPrice: toDineroPrice("0", input.currency),
            })),
          }

    const usageFeatureResult = await createPlanVersionFeature({
      planVersion,
      feature: usageFeature.val,
      featureType: "usage",
      config: usageConfig,
      order: 6144,
      defaultQuantity: 1,
      limit: template.usage.config.limit,
      meterConfig: usageMeterConfig.val,
    })

    if (usageFeatureResult.err) {
      return Err(usageFeatureResult.err)
    }

    if (usageFeatureResult.val.state !== "ok") {
      return Ok(usageFeatureResult.val)
    }

    const creditsMeterConfig = await buildMeterConfig({
      featureSlug: creditsFeature.val.slug,
      aggregationMethod: "sum",
    })

    if (creditsMeterConfig.err) {
      return Err(creditsMeterConfig.err)
    }

    const creditsFeatureResult = await createPlanVersionFeature({
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
            unitPrice: toDineroPrice("0.01", input.currency),
            flatPrice: toDineroPrice("0", input.currency),
          },
          {
            firstUnit: 1001,
            lastUnit: 10000,
            unitPrice: toDineroPrice("0.0075", input.currency),
            flatPrice: toDineroPrice("0", input.currency),
          },
          {
            firstUnit: 10001,
            lastUnit: null,
            unitPrice: toDineroPrice("0.005", input.currency),
            flatPrice: toDineroPrice("0", input.currency),
          },
        ],
      },
      order: 7168,
      defaultQuantity: 1,
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

    if (creditsFeatureResult.err) {
      return Err(creditsFeatureResult.err)
    }

    if (creditsFeatureResult.val.state !== "ok") {
      return Ok(creditsFeatureResult.val)
    }

    if (input.publish) {
      const published = await publishPlanVersionFlow(
        {
          services: deps.services,
          db: deps.db,
          logger: deps.logger,
          userId: deps.userId,
        },
        {
          id: planVersion.id,
          projectId: input.projectId,
          workspaceUnPriceCustomerId: input.workspaceUnPriceCustomerId,
        }
      )

      if (published.err) {
        return Err(published.err)
      }

      if (published.val.state !== "ok") {
        return Ok({
          state: published.val.state,
        })
      }
    }

    appliedTemplates.push({
      key: template.key,
      label: template.label,
      planId: plan.val.id,
      planVersionId: planVersion.id,
    })
  }

  const primaryPlanVersionId = appliedTemplates[0]?.planVersionId

  if (!primaryPlanVersionId) {
    return Err(
      new FetchError({
        message: "Plan template did not create any plan versions",
        retry: false,
      })
    )
  }

  return Ok({
    state: "ok",
    primaryPlanVersionId,
    appliedTemplates,
  })
}
