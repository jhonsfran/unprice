import type { Database } from "@unprice/db"
import {
  type SubscriptionChangePlan,
  type SubscriptionPhase,
  subscriptionChangePlanSchema,
  subscriptionStatusSchema,
} from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { UnPriceBillingError } from "../../billing/errors"
import type { ServiceContext } from "../../context"
import type { DomainErrorKind } from "../../domain-error-kind"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"
import { checkPaymentProviderAvailability } from "../payment-provider/availability"

export const subscriptionChangePhasePlanOutputSchema = z.object({
  status: subscriptionStatusSchema,
  phaseId: z.string(),
  message: z.string(),
})

const subscriptionChangePlanErrorCodeSchema = z.enum([
  "SUBSCRIPTION_CHANGE_PLAN_NOT_FOUND",
  "SUBSCRIPTION_CHANGE_PLAN_NOT_ACTIVE",
  "SUBSCRIPTION_CHANGE_PLAN_ACTIVE_PHASE_NOT_FOUND",
  "SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED",
  "SUBSCRIPTION_CHANGE_PLAN_SAME_PLAN_VERSION",
  "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND",
  "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_INACTIVE",
  "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_UNPUBLISHED",
  "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_ARCHIVED",
  "SUBSCRIPTION_CHANGE_PLAN_PROVIDER_UNAVAILABLE",
])

type SubscriptionChangePlanErrorCode = z.infer<typeof subscriptionChangePlanErrorCodeSchema>

const subscriptionChangePlanErrorKinds: Record<SubscriptionChangePlanErrorCode, DomainErrorKind> = {
  SUBSCRIPTION_CHANGE_PLAN_NOT_FOUND: "bad_request",
  SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND: "bad_request",
  SUBSCRIPTION_CHANGE_PLAN_NOT_ACTIVE: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_ACTIVE_PHASE_NOT_FOUND: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_SAME_PLAN_VERSION: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_INACTIVE: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_UNPUBLISHED: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_ARCHIVED: "precondition",
  SUBSCRIPTION_CHANGE_PLAN_PROVIDER_UNAVAILABLE: "precondition",
}

export type SubscriptionChangePhasePlanOutput = z.infer<
  typeof subscriptionChangePhasePlanOutputSchema
>

export type SubscriptionChangePhasePlanDeps = {
  services: Pick<ServiceContext, "billing" | "plans" | "subscriptions">
  db: Database
  logger: Logger
  now?: () => number
}

type SubscriptionChangePhasePlanFailure =
  | FetchError
  | SchemaError
  | UnPriceBillingError
  | UnPriceSubscriptionError
  | SubscriptionChangePhasePlanError

export class SubscriptionChangePhasePlanError extends BaseError<{
  projectId?: string
  subscriptionId?: string
  targetPlanVersionId?: string
}> {
  public readonly code: SubscriptionChangePlanErrorCode
  public readonly kind: DomainErrorKind
  public readonly retry = false
  public override readonly name = "SubscriptionChangePhasePlanError"

  constructor(opts: {
    code: SubscriptionChangePlanErrorCode
    message: string
    context?: {
      projectId?: string
      subscriptionId?: string
      targetPlanVersionId?: string
    }
  }) {
    super({
      message: opts.message,
      context: opts.context ?? {},
    })
    this.code = opts.code
    this.kind = subscriptionChangePlanErrorKinds[opts.code]
  }
}

export async function changeSubscriptionPhasePlan(
  deps: SubscriptionChangePhasePlanDeps,
  rawInput: SubscriptionChangePlan
): Promise<Result<SubscriptionChangePhasePlanOutput, SubscriptionChangePhasePlanFailure>> {
  const input = subscriptionChangePlanSchema.parse(rawInput)
  const projectId = input.projectId
  const now = deps.now?.() ?? Date.now()
  const whenToChange = input.whenToChange ?? "end_of_cycle"

  deps.logger.set({
    business: {
      operation: "subscription.change_phase_plan",
      project_id: projectId,
      subscription_id: input.id,
      target_plan_version_id: input.planVersionId,
      when_to_change: whenToChange,
    },
  })

  const subscriptionResult = await deps.services.subscriptions.getSubscriptionById({
    subscriptionId: input.id,
    projectId,
  })

  if (subscriptionResult.err) {
    return Err(subscriptionResult.err)
  }

  if (!subscriptionResult.val) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_NOT_FOUND",
        message: "Subscription not found",
        context: {
          projectId,
          subscriptionId: input.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  const subscription = subscriptionResult.val

  if (!subscription.active) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_NOT_ACTIVE",
        message: "Subscription must be active to schedule a phase change",
        context: {
          projectId,
          subscriptionId: input.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  const activePhase = subscription.phases.find(
    (phase) => phase.startAt <= now && (phase.endAt ?? Number.POSITIVE_INFINITY) >= now
  )

  if (!activePhase) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_ACTIVE_PHASE_NOT_FOUND",
        message: "Subscription does not have an active phase",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  if (activePhase.planVersionId === input.planVersionId) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_SAME_PLAN_VERSION",
        message: "Subscription is already using this plan version",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  const futurePhase = subscription.phases.find((phase) => phase.startAt > now)

  if (futurePhase) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED",
        message: "A future phase is already scheduled. Remove it before scheduling another change.",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  const targetPlanVersionResult = await deps.services.plans.getPlanVersionByIdRecord({
    planVersionId: input.planVersionId,
    projectId,
  })

  if (targetPlanVersionResult.err) {
    return Err(targetPlanVersionResult.err)
  }

  const targetPlanVersion = targetPlanVersionResult.val

  if (!targetPlanVersion) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND",
        message: "Target plan version was not found",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  if (!targetPlanVersion.active) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_INACTIVE",
        message: "Target plan version is inactive",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  if (targetPlanVersion.status !== "published") {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_UNPUBLISHED",
        message: "Target plan version is not published",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  if (targetPlanVersion.archived) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_ARCHIVED",
        message: "Target plan version is archived",
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  const providerAvailabilityResult = await checkPaymentProviderAvailability(deps, {
    projectId,
    paymentProvider: targetPlanVersion.paymentProvider,
  })

  if (providerAvailabilityResult.err) {
    return Err(providerAvailabilityResult.err)
  }

  if (!providerAvailabilityResult.val.available) {
    return Err(
      new SubscriptionChangePhasePlanError({
        code: "SUBSCRIPTION_CHANGE_PLAN_PROVIDER_UNAVAILABLE",
        message: providerAvailabilityResult.val.message,
        context: {
          projectId,
          subscriptionId: subscription.id,
          targetPlanVersionId: input.planVersionId,
        },
      })
    )
  }

  let transactionError: SubscriptionChangePhasePlanFailure | undefined
  const transactionResult = await deps.db
    .transaction(async (tx) => {
      const targetStartAt =
        whenToChange === "immediately" ? now + 1 : subscription.currentCycleEndAt
      const currentPhaseEndAt =
        whenToChange === "immediately" ? now : subscription.currentCycleEndAt - 1
      const targetPhaseEvaluationNow = whenToChange === "immediately" ? targetStartAt : now
      const billingPeriodsNow = whenToChange === "immediately" ? targetStartAt : now
      const closeCurrentPhaseInput: SubscriptionPhase = {
        id: activePhase.id,
        projectId,
        subscriptionId: subscription.id,
        planVersionId: activePhase.planVersionId,
        paymentProvider: activePhase.paymentProvider,
        creditLinePolicy: activePhase.creditLinePolicy ?? "uncapped",
        creditLineAmount:
          activePhase.creditLinePolicy === "uncapped"
            ? null
            : (activePhase.creditLineAmount ?? null),
        paymentMethodId: activePhase.paymentMethodId,
        trialUnits: activePhase.trialUnits,
        trialEndsAt: activePhase.trialEndsAt,
        billingAnchor: activePhase.billingAnchor,
        startAt: activePhase.startAt,
        endAt: currentPhaseEndAt,
        metadata: activePhase.metadata ?? null,
        items: [],
      }

      const closeResult = await deps.services.subscriptions.updatePhase({
        input: closeCurrentPhaseInput,
        subscriptionId: subscription.id,
        projectId,
        db: tx,
        now,
      })

      if (closeResult.err) {
        transactionError = closeResult.err
        throw closeResult.err
      }

      const createResult = await deps.services.subscriptions.createPhase({
        input: {
          subscriptionId: subscription.id,
          customerId: subscription.customerId,
          planVersionId: input.planVersionId,
          startAt: targetStartAt,
          config: input.config,
          paymentProvider: targetPlanVersion.paymentProvider,
          paymentMethodId: input.paymentMethodId ?? undefined,
          paymentMethodRequired:
            input.paymentMethodRequired ?? targetPlanVersion.paymentMethodRequired,
          creditLinePolicy: input.creditLinePolicy ?? "uncapped",
          creditLineAmount: input.creditLineAmount ?? null,
          trialUnits: input.trialUnits ?? targetPlanVersion.trialUnits ?? 0,
        },
        projectId,
        db: tx,
        now: targetPhaseEvaluationNow,
      })

      if (createResult.err) {
        transactionError = createResult.err
        throw createResult.err
      }

      const periodsResult = await deps.services.billing.generateBillingPeriods({
        projectId,
        subscriptionId: subscription.id,
        now: billingPeriodsNow,
        db: tx,
      })

      if (periodsResult.err) {
        transactionError = periodsResult.err
        throw periodsResult.err
      }

      return createResult.val
    })
    .then((phase) => Ok(phase))
    .catch((error) =>
      Err(
        transactionError ??
          new FetchError({
            message: error instanceof Error ? error.message : String(error),
            retry: false,
          })
      )
    )

  if (transactionResult.err) {
    return Err(transactionResult.err)
  }

  return Ok(
    subscriptionChangePhasePlanOutputSchema.parse({
      status: subscription.status,
      phaseId: transactionResult.val.id,
      message:
        whenToChange === "immediately"
          ? "Subscription phase changed successfully"
          : "Subscription phase scheduled successfully",
    })
  )
}
