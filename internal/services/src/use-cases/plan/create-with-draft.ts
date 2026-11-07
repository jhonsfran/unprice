import type { Currency, InsertPlan, Plan, PlanVersion } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { type CreatePlanDeps, insertPlan } from "./create"

export type CreatePlanWithDraftInput = {
  input: InsertPlan
  projectId: string
  /** The project's default currency: the draft's currency. */
  currency: Currency
  /** Trial length in the billing interval's unit; none by default. */
  trialUnits?: number
}

/**
 * Creates a plan and its first draft version in one step, so a new plan opens in the version
 * editor instead of on the plans list. The draft takes the project's defaults: monthly, billed in
 * arrears, charged automatically, on the sandbox provider; every setting can be edited on the
 * version afterwards. The two writes are separate: a failure after the plan exists leaves a plan
 * without a version, which the plan page offers to create.
 */
export async function createPlanWithDraft(
  deps: CreatePlanDeps,
  params: CreatePlanWithDraftInput
): Promise<Result<{ plan: Plan; planVersion: PlanVersion }, FetchError>> {
  const { input, projectId, currency, trialUnits } = params
  deps.logger.set({
    business: {
      operation: "plan.create_with_draft",
      project_id: projectId,
    },
  })

  const plan = await insertPlan(deps, { input, projectId })
  if (plan.err) return Err(plan.err)

  const version = await deps.services.plans.createPlanVersionRecord({
    projectId,
    planId: plan.val.id,
    metadata: null,
    description: input.description ?? "",
    currency,
    billingConfig: {
      name: "monthly",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    },
    gracePeriod: 0,
    title: input.title,
    tags: [],
    whenToBill: "pay_in_arrear",
    paymentProvider: "sandbox",
    trialUnits: trialUnits ?? 0,
    autoRenew: true,
    collectionMethod: "charge_automatically",
    dueBehaviour: "cancel",
    paymentMethodRequired: false,
  })
  if (version.err) return Err(version.err)
  if (version.val.state !== "ok") {
    return Err(
      new FetchError({
        message: `plan ${plan.val.id} was created but its first version was not`,
        retry: false,
      })
    )
  }
  return Ok({ plan: plan.val, planVersion: version.val.planVersion })
}
