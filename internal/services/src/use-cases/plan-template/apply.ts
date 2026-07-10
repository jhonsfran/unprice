import type { Database } from "@unprice/db"
import type { Event, Feature, PlanVersion } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { publishPlanVersion } from "../plan-version/publish"
import {
  type PlanTemplateMaterializeCaches,
  createTemplatePlanVersion,
  getExistingTemplatePlanVersion,
  getOrCreateFeature,
  getOrCreatePlan,
  isTemplatePlanVersionComplete,
  materializeTemplatePlanFeatures,
} from "./materialize"
import {
  type ApplyPlanTemplateInput,
  type ApplyPlanTemplateOutput,
  BASE_FEE_FEATURE,
  CREDITS_FEATURE,
  applyPlanTemplateInputSchema,
  getExpectedFeatureSlugs,
  getTemplateVersionTags,
  resolveTemplate,
} from "./template-data"

export {
  appliedPlanTemplateSchema,
  applyPlanTemplateInputSchema,
  applyPlanTemplateOutputSchema,
  applyPlanTemplateRequestSchema,
  planTemplateKeySchema,
} from "./template-data"
export type {
  ApplyPlanTemplateInput,
  ApplyPlanTemplateOutput,
  ApplyPlanTemplateRequest,
} from "./template-data"

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

export async function applyPlanTemplate(
  deps: ApplyPlanTemplateDeps,
  rawInput: ApplyPlanTemplateInput
): Promise<Result<ApplyPlanTemplateOutput | { state: ApplyPlanTemplateFailureState }, FetchError>> {
  const input = applyPlanTemplateInputSchema.parse(rawInput)
  const templates = resolveTemplate(input.template)
  const caches: PlanTemplateMaterializeCaches = {
    features: new Map<string, Feature>(),
    events: new Map<string, Event>(),
    planVersionFeatureSlugs: new Map<string, Set<string>>(),
  }
  const context = {
    deps,
    projectId: input.projectId,
    caches,
  }

  deps.logger.set({
    business: {
      operation: "plan-template.apply",
      project_id: input.projectId,
    },
  })

  for (const commonFeature of [BASE_FEE_FEATURE, CREDITS_FEATURE]) {
    const feature = await getOrCreateFeature(context, commonFeature)
    if (feature.err) return Err(feature.err)
  }

  const appliedTemplates: ApplyPlanTemplateOutput["appliedTemplates"] = []

  for (const template of templates) {
    const plan = await getOrCreatePlan(context, template.plan)
    if (plan.err) return Err(plan.err)

    const tags = getTemplateVersionTags(input.template, template.key)
    const expectedFeatureSlugs = getExpectedFeatureSlugs(template)
    const existing = await getExistingTemplatePlanVersion(context, {
      planId: plan.val.id,
      tags,
      currency: input.currency,
      paymentProvider: input.paymentProvider,
      expectedFeatureSlugs,
    })
    if (existing.err) return Err(existing.err)

    let planVersion: PlanVersion | undefined = existing.val?.planVersion
    let complete = existing.val?.complete ?? false
    if (planVersion) {
      caches.planVersionFeatureSlugs.set(planVersion.id, existing.val?.featureSlugs ?? new Set())
    }

    if (!planVersion) {
      const created = await createTemplatePlanVersion(context, {
        planId: plan.val.id,
        template,
        currency: input.currency,
        paymentProvider: input.paymentProvider,
        tags,
      })
      if (created.err) return Err(created.err)
      if (created.val.state !== "ok") return Ok({ state: created.val.state })

      planVersion = created.val.planVersion
      caches.planVersionFeatureSlugs.set(planVersion.id, new Set())
    }

    if (!complete) {
      const materialized = await materializeTemplatePlanFeatures(context, {
        template,
        planVersion,
        currency: input.currency,
      })
      if (materialized.err) return Err(materialized.err)
      if (materialized.val.state !== "ok") return Ok(materialized.val)

      complete = isTemplatePlanVersionComplete(
        caches.planVersionFeatureSlugs.get(planVersion.id) ?? new Set(),
        expectedFeatureSlugs
      )
    }

    if (!complete) {
      return Err(
        new FetchError({
          message: `Template plan version ${planVersion.id} is missing expected features`,
          retry: true,
        })
      )
    }

    if (input.publish && planVersion.status !== "published") {
      const published = await publishPlanVersion(
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
      if (published.err) return Err(published.err)
      if (published.val.state !== "ok" && published.val.state !== "already_published") {
        return Ok({ state: published.val.state })
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

  return Ok({ state: "ok", primaryPlanVersionId, appliedTemplates })
}
