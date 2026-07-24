import {
  type PlanVersionFeature,
  currencySchema,
  eventInsertBaseSchema,
  paidActionSchema,
  paymentProviderSchema,
} from "@unprice/db/validators"
import { z } from "zod"

const ONBOARDING_TEMPLATE_KEY = "saas_onboarding"
const TEMPLATE_SOURCE_TAG_PREFIX = "template:"
const TEMPLATE_PLAN_TAG_PREFIX = "template-plan:"

export const ONBOARDING_USAGE_EVENT_SLUG = "workflow_runs"
export const ONBOARDING_USAGE_EVENT_NAME = "Workflow Runs"

export const planTemplateKeySchema = z.enum([ONBOARDING_TEMPLATE_KEY])

export { paidActionSchema }

export const applyPlanTemplateRequestSchema = z.object({
  template: planTemplateKeySchema.default(ONBOARDING_TEMPLATE_KEY),
  currency: currencySchema.default("USD"),
  paymentProvider: paymentProviderSchema.default("sandbox"),
  publish: z.boolean().default(false),
  paidAction: paidActionSchema.optional(),
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
export type PaidAction = z.infer<typeof paidActionSchema>

const templateFeatureSchema = z.object({
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  unitOfMeasure: z.string(),
})

const usageConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("unit"),
    price: z.string(),
    limit: z.number().optional(),
    aggregationMethod: z.enum(["count", "sum", "latest"]).optional(),
  }),
  z.object({
    mode: z.literal("tier"),
    tiers: z.array(
      z.object({
        firstUnit: z.number(),
        lastUnit: z.number().nullable(),
        unitPrice: z.string(),
      })
    ),
    limit: z.number().optional(),
    aggregationMethod: z.enum(["sum", "latest"]).optional(),
  }),
])

const templatePlanSchema = z.object({
  key: z.string(),
  label: z.string(),
  plan: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
  }),
  billingConfig: z.object({
    name: z.string(),
    interval: z.enum(["month", "year"]),
    intervalCount: z.number(),
  }),
  baseFee: z.string(),
  seatPack: z
    .object({
      price: z.string(),
      units: z.number(),
    })
    .optional(),
  usage: templateFeatureSchema.extend({
    config: usageConfigSchema,
    eventSlug: eventInsertBaseSchema.shape.slug.optional(),
    eventName: eventInsertBaseSchema.shape.name.optional(),
  }),
  flatFeatures: z.array(templateFeatureSchema),
})

export type TemplateFeature = z.infer<typeof templateFeatureSchema>
export type TemplatePlan = z.infer<typeof templatePlanSchema>

export const BASE_FEE_FEATURE: TemplateFeature = {
  title: "Workflow Runtime Access",
  slug: "workflow-runtime-access",
  description: "Base access to the workflow runtime.",
  unitOfMeasure: "access",
}

export const SEAT_FEATURE: TemplateFeature = {
  title: "Operator Seats",
  slug: "operator-seats",
  description: "Team seats for operating workflows.",
  unitOfMeasure: "seat",
}

export const CREDITS_FEATURE: TemplateFeature = {
  title: "Credits",
  slug: "credits",
  description:
    "Metered credits consumed by workflow steps inside a budgeted run. Use this when one run can fan out into variable work.",
  unitOfMeasure: "credit",
}

export const DEFAULT_FEATURE_METADATA = {
  realtime: false,
  notifyUsageThreshold: 95,
  overageStrategy: "none",
  blockCustomer: false,
  hidden: false,
} satisfies NonNullable<PlanVersionFeature["metadata"]>

const SAAS_ONBOARDING_TEMPLATE = templatePlanSchema.array().parse([
  {
    key: "starter",
    label: "Starter",
    plan: {
      title: "Starter",
      slug: "starter",
      description: "Entry plan for one production workflow.",
    },
    billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
    baseFee: "49",
    seatPack: { price: "12", units: 5 },
    usage: {
      title: "Runs",
      slug: "runs",
      description:
        "Customer-triggered workflow executions. The workflow_runs event records each run in the request path.",
      unitOfMeasure: "run",
      config: { mode: "unit", price: "0.08", limit: 1000, aggregationMethod: "count" },
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
    billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
    baseFee: "149",
    seatPack: { price: "18", units: 10 },
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
    billingConfig: { name: "annual", interval: "year", intervalCount: 1 },
    baseFee: "2400",
    usage: {
      title: "Runs",
      slug: "runs",
      description:
        "Customer-triggered workflow executions with annual enterprise pricing. The workflow_runs event carries the workflow context.",
      unitOfMeasure: "run",
      config: { mode: "unit", price: "0.03", limit: 250000, aggregationMethod: "count" },
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
])

export function resolveTemplate(
  template: z.infer<typeof planTemplateKeySchema>,
  paidAction?: PaidAction
) {
  switch (template) {
    case ONBOARDING_TEMPLATE_KEY: {
      if (!paidAction) {
        return SAAS_ONBOARDING_TEMPLATE
      }

      const primaryTemplate = SAAS_ONBOARDING_TEMPLATE[0]
      if (!primaryTemplate) {
        throw new Error("SAAS_ONBOARDING_TEMPLATE must define a primary plan")
      }

      return templatePlanSchema.array().parse([
        {
          ...primaryTemplate,
          baseFee: "0",
          seatPack: undefined,
          flatFeatures: [],
          usage: {
            title: paidAction.title,
            slug: paidAction.featureSlug,
            description: `${paidAction.title} is authorized in the request path before paid work runs.`,
            unitOfMeasure: paidAction.unitOfMeasure,
            eventSlug: paidAction.eventSlug,
            eventName: `${paidAction.title} requested`,
            config: {
              mode: "unit",
              price: paidAction.unitPrice,
              aggregationMethod: "count",
            },
          },
        },
      ])
    }
  }
}

export function getTemplateVersionTags(
  templateKey: string,
  templatePlanKey: string,
  paidAction?: PaidAction
) {
  const tags = [
    `${TEMPLATE_SOURCE_TAG_PREFIX}${templateKey}`,
    `${TEMPLATE_PLAN_TAG_PREFIX}${templatePlanKey}`,
  ]

  if (paidAction) {
    tags.push(
      `paid-action:${paidAction.featureSlug}:${paidAction.eventSlug}:${paidAction.unitPrice}`
    )
  }

  return tags
}

export function getExpectedFeatureSlugs(template: TemplatePlan) {
  return new Set([
    BASE_FEE_FEATURE.slug,
    CREDITS_FEATURE.slug,
    ...(template.seatPack || template.usage.slug === SEAT_FEATURE.slug ? [SEAT_FEATURE.slug] : []),
    ...template.flatFeatures.map(({ slug }) => slug),
    template.usage.slug,
  ])
}
