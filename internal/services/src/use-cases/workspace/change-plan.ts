import type { Database } from "@unprice/db"
import {
  type PaymentProvider,
  type SubscriptionPhase,
  getAnchor,
  paymentProviderSchema,
  subscriptionItemsConfigSchema,
} from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { UnPriceBillingError } from "../../billing/errors"
import type { ServiceContext } from "../../context"
import type { UnPriceCustomerError } from "../../customers/errors"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"
import {
  type GetCustomerCurrentAccessAnalytics,
  getCustomerCurrentAccess,
} from "../customer/get-current-access"
import { checkPaymentProviderAvailability } from "../payment-provider/availability"
import { isMissingDefaultPaymentMethodError } from "./get-upgrade-options"

export const workspaceChangePlanInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  targetPlanVersionId: z.string().min(1),
  whenToChange: z.enum(["immediately", "end_of_cycle"]),
  config: subscriptionItemsConfigSchema.optional(),
})

export const workspaceChangePlanOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("changed"),
    subscriptionId: z.string(),
    phaseId: z.string(),
  }),
  z.object({
    status: z.literal("scheduled"),
    subscriptionId: z.string(),
    phaseId: z.string(),
    effectiveAt: z.number(),
  }),
  z.object({
    status: z.literal("requires_payment_method"),
    paymentProvider: paymentProviderSchema,
    message: z.string(),
  }),
])

const workspaceChangePlanErrorCodeSchema = z.enum([
  "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
  "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
  "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
  "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
  "WORKSPACE_TARGET_PLAN_VERSION_NOT_FOUND",
  "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT",
  "WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT",
  "WORKSPACE_TARGET_PLAN_VERSION_INACTIVE",
  "WORKSPACE_TARGET_PLAN_VERSION_UNPUBLISHED",
  "WORKSPACE_TARGET_PLAN_VERSION_ARCHIVED",
  "WORKSPACE_TARGET_PLAN_VERSION_WRONG_CURRENCY",
  "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE",
])

type WorkspaceChangePlanErrorCode = z.infer<typeof workspaceChangePlanErrorCodeSchema>

export type WorkspaceChangePlanInput = z.infer<typeof workspaceChangePlanInputSchema>
export type WorkspaceChangePlanOutput = z.infer<typeof workspaceChangePlanOutputSchema>
type WorkspaceBillingContext = {
  id: string
  slug: string
  unPriceCustomerId: string | null
}

export type WorkspaceChangePlanDeps = {
  services: Pick<ServiceContext, "billing" | "customers" | "plans" | "subscriptions">
  db: Database
  analytics: GetCustomerCurrentAccessAnalytics
  logger: Logger
  now?: () => number
}

type WorkspaceChangePlanFailure =
  | FetchError
  | SchemaError
  | UnPriceBillingError
  | UnPriceCustomerError
  | UnPriceSubscriptionError
  | WorkspaceChangePlanError

export class WorkspaceChangePlanError extends BaseError<{
  billingProjectId?: string
  customerId?: string
  targetPlanVersionId?: string
  workspaceId?: string
}> {
  public readonly code: WorkspaceChangePlanErrorCode
  public readonly retry = false
  public override readonly name = "WorkspaceChangePlanError"

  constructor(opts: {
    code: WorkspaceChangePlanErrorCode
    message: string
    context?: {
      billingProjectId?: string
      customerId?: string
      targetPlanVersionId?: string
      workspaceId?: string
    }
  }) {
    super({
      message: opts.message,
      context: opts.context ?? {},
    })
    this.code = opts.code
  }
}

function paymentMethodRequiredReason(paymentProvider: PaymentProvider): string {
  switch (paymentProvider) {
    case "sandbox":
      return "Add a payment method before changing to this plan."
    case "square":
    case "stripe":
      return "Add a default payment method before changing to this plan."
  }

  return "Add a payment method before changing to this plan."
}

function notFoundTargetPlanMessage(): string {
  return "Target plan version was not found for this workspace billing project"
}

export async function changeWorkspacePlan(
  deps: WorkspaceChangePlanDeps,
  rawInput: WorkspaceChangePlanInput & {
    workspace: WorkspaceBillingContext
  }
): Promise<Result<WorkspaceChangePlanOutput, WorkspaceChangePlanFailure>> {
  const input = workspaceChangePlanInputSchema.parse(rawInput)
  const customerId = rawInput.workspace.unPriceCustomerId

  deps.logger.set({
    business: {
      operation: "workspace.change_plan",
      workspace_id: rawInput.workspace.id,
      unprice_customer_id: customerId ?? undefined,
      target_plan_version_id: input.targetPlanVersionId,
      when_to_change: input.whenToChange,
    },
  })

  if (!customerId) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
        message: "Workspace billing customer not found",
        context: {
          workspaceId: rawInput.workspace.id,
        },
      })
    )
  }

  const customerResult = await deps.services.customers.getCustomerByIdAcrossProjects(customerId, {
    skipCache: true,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  const customer = customerResult.val

  if (!customer) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
        message: "Workspace billing customer not found",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
        },
      })
    )
  }

  const billingProjectId = customer.projectId
  const customerCurrency = customer.defaultCurrency ?? customer.project.defaultCurrency

  if (!customerCurrency) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
        message: "Workspace billing currency not found",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  const accessResult = await getCustomerCurrentAccess(
    {
      db: deps.db,
      analytics: deps.analytics,
      logger: deps.logger,
      now: deps.now,
    },
    {
      projectId: billingProjectId,
      customerId,
    }
  )

  if (accessResult.err) {
    return Err(accessResult.err)
  }

  const activePlan = accessResult.val?.activePlan
  const activePhase = activePlan?.activePhase

  if (!activePlan || !activePhase) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
        message: "Workspace billing access not found",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  if (activePhase.planVersionId === input.targetPlanVersionId) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT",
        message: "Workspace is already subscribed to this plan",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: input.targetPlanVersionId,
        },
      })
    )
  }

  const targetPlanVersionResult = await deps.services.plans.getPlanVersionByIdRecord({
    planVersionId: input.targetPlanVersionId,
    projectId: billingProjectId,
  })

  if (targetPlanVersionResult.err) {
    return Err(targetPlanVersionResult.err)
  }

  const targetPlanVersion = targetPlanVersionResult.val

  if (!targetPlanVersion) {
    const versionAcrossProjects = await deps.db.query.versions.findFirst({
      columns: {
        id: true,
        projectId: true,
      },
      where: (version, { eq }) => eq(version.id, input.targetPlanVersionId),
    })

    if (versionAcrossProjects && versionAcrossProjects.projectId !== billingProjectId) {
      return Err(
        new WorkspaceChangePlanError({
          code: "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT",
          message: notFoundTargetPlanMessage(),
          context: {
            workspaceId: rawInput.workspace.id,
            customerId,
            billingProjectId,
            targetPlanVersionId: input.targetPlanVersionId,
          },
        })
      )
    }

    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_NOT_FOUND",
        message: notFoundTargetPlanMessage(),
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: input.targetPlanVersionId,
        },
      })
    )
  }

  if (!targetPlanVersion.active) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_INACTIVE",
        message: "Target plan version is inactive",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: targetPlanVersion.id,
        },
      })
    )
  }

  if (targetPlanVersion.status !== "published") {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_UNPUBLISHED",
        message: "Target plan version is not published",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: targetPlanVersion.id,
        },
      })
    )
  }

  if (targetPlanVersion.archived) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_ARCHIVED",
        message: "Target plan version is archived",
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: targetPlanVersion.id,
        },
      })
    )
  }

  if (targetPlanVersion.currency !== customerCurrency) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_WRONG_CURRENCY",
        message: `Target plan version uses ${targetPlanVersion.currency}, but the workspace billing currency is ${customerCurrency}`,
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: targetPlanVersion.id,
        },
      })
    )
  }

  const providerAvailabilityResult = await checkPaymentProviderAvailability(deps, {
    projectId: billingProjectId,
    paymentProvider: targetPlanVersion.paymentProvider,
  })

  if (providerAvailabilityResult.err) {
    return Err(providerAvailabilityResult.err)
  }

  if (!providerAvailabilityResult.val.available) {
    return Err(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE",
        message: providerAvailabilityResult.val.message,
        context: {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: targetPlanVersion.id,
        },
      })
    )
  }

  let paymentMethodId: string | null = null

  if (targetPlanVersion.paymentMethodRequired) {
    const paymentMethodValidationResult = await deps.services.customers.validatePaymentMethod({
      customerId,
      projectId: billingProjectId,
      paymentProvider: targetPlanVersion.paymentProvider,
      requiredPaymentMethod: true,
    })

    if (paymentMethodValidationResult.err) {
      if (isMissingDefaultPaymentMethodError(paymentMethodValidationResult.err)) {
        return Ok(
          workspaceChangePlanOutputSchema.parse({
            status: "requires_payment_method",
            paymentProvider: targetPlanVersion.paymentProvider,
            message: paymentMethodRequiredReason(targetPlanVersion.paymentProvider),
          })
        )
      }

      return Err(paymentMethodValidationResult.err)
    }

    paymentMethodId = paymentMethodValidationResult.val.paymentMethodId
  }

  const subscriptionId = activePlan.subscriptionId
  const currentCycleEndAt = activePlan.currentCycleEndAt
  const now = deps.now?.() ?? Date.now()
  let transactionError: WorkspaceChangePlanFailure | undefined

  const transactionResult = await deps.db
    .transaction(async (tx) => {
      const services = deps.services
      const targetStartAt = input.whenToChange === "immediately" ? now + 1 : currentCycleEndAt
      const currentPhaseEndAt = input.whenToChange === "immediately" ? now : currentCycleEndAt - 1
      const targetPhaseEvaluationNow = input.whenToChange === "immediately" ? targetStartAt : now
      const billingPeriodsNow = input.whenToChange === "immediately" ? targetStartAt : now
      const currentPhaseCreditLinePolicy: SubscriptionPhase["creditLinePolicy"] =
        activePhase.creditLinePolicy === "capped" ? "capped" : "uncapped"
      const currentPhaseBillingAnchor = getAnchor(
        activePhase.startAt,
        activePhase.planVersion.billingConfig.billingInterval,
        activePhase.planVersion.billingConfig.billingAnchor
      )
      const closeCurrentPhaseInput: SubscriptionPhase = {
        id: activePhase.id,
        projectId: billingProjectId,
        subscriptionId,
        planVersionId: activePhase.planVersionId,
        paymentProvider: activePhase.paymentProvider,
        creditLinePolicy: currentPhaseCreditLinePolicy,
        creditLineAmount: activePhase.creditLineAmount,
        billingAnchor: currentPhaseBillingAnchor,
        trialUnits: 0,
        paymentMethodId: activePhase.paymentMethodId,
        trialEndsAt: null,
        startAt: activePhase.startAt,
        endAt: currentPhaseEndAt,
        items: [],
      }

      const closeResult = await services.subscriptions.updatePhase({
        input: closeCurrentPhaseInput,
        subscriptionId,
        projectId: billingProjectId,
        db: tx,
        now,
      })

      if (closeResult.err) {
        transactionError = closeResult.err
        throw closeResult.err
      }

      const createResult = await services.subscriptions.createPhase({
        input: {
          subscriptionId,
          customerId,
          planVersionId: input.targetPlanVersionId,
          startAt: targetStartAt,
          config: input.config,
          paymentProvider: targetPlanVersion.paymentProvider,
          paymentMethodId,
          paymentMethodRequired: targetPlanVersion.paymentMethodRequired,
        },
        projectId: billingProjectId,
        db: tx,
        now: targetPhaseEvaluationNow,
      })

      if (createResult.err) {
        transactionError = createResult.err
        throw createResult.err
      }

      const periodsResult = await services.billing.generateBillingPeriods({
        projectId: billingProjectId,
        subscriptionId,
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
    workspaceChangePlanOutputSchema.parse(
      input.whenToChange === "immediately"
        ? {
            status: "changed",
            subscriptionId,
            phaseId: transactionResult.val.id,
          }
        : {
            status: "scheduled",
            subscriptionId,
            phaseId: transactionResult.val.id,
            effectiveAt: currentCycleEndAt,
          }
    )
  )
}
