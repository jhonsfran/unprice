import type { Database } from "@unprice/db"
import {
  type PaymentProvider,
  paymentProviderSchema,
  subscriptionItemsConfigSchema,
} from "@unprice/db/validators"
import { BaseError, Err, type FetchError, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { UnPriceBillingError } from "../../billing/errors"
import type { ServiceContext } from "../../context"
import type { UnPriceCustomerError } from "../../customers/errors"
import type { DomainErrorKind } from "../../domain-error-kind"
import {
  type UnPricePaymentProviderError,
  isMissingPaymentMethodError,
} from "../../payment-provider/errors"
import type { UnPriceSubscriptionError } from "../../subscriptions/errors"
import {
  type GetCustomerCurrentAccessAnalytics,
  getCustomerCurrentAccess,
} from "../customer/get-current-access"
import { checkPaymentProviderAvailability } from "../payment-provider/availability"
import {
  SubscriptionChangePhasePlanError,
  changeSubscriptionPhasePlan,
} from "../subscription/change-plan"
import { scheduledPlanChangeUnavailableReason } from "./scheduled-plan-change"

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
  "WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED",
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

const workspaceChangePlanErrorKinds: Record<WorkspaceChangePlanErrorCode, DomainErrorKind> = {
  WORKSPACE_BILLING_CUSTOMER_ID_MISSING: "bad_request",
  WORKSPACE_TARGET_PLAN_VERSION_NOT_FOUND: "bad_request",
  WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT: "bad_request",
  WORKSPACE_BILLING_CUSTOMER_NOT_FOUND: "precondition",
  WORKSPACE_BILLING_CURRENCY_NOT_FOUND: "precondition",
  WORKSPACE_BILLING_ACCESS_NOT_FOUND: "precondition",
  WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED: "precondition",
  WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT: "precondition",
  WORKSPACE_TARGET_PLAN_VERSION_INACTIVE: "precondition",
  WORKSPACE_TARGET_PLAN_VERSION_UNPUBLISHED: "precondition",
  WORKSPACE_TARGET_PLAN_VERSION_ARCHIVED: "precondition",
  WORKSPACE_TARGET_PLAN_VERSION_WRONG_CURRENCY: "precondition",
  WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE: "precondition",
}

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
  | UnPricePaymentProviderError
  | UnPriceSubscriptionError
  | WorkspaceChangePlanError

export class WorkspaceChangePlanError extends BaseError<{
  billingProjectId?: string
  customerId?: string
  targetPlanVersionId?: string
  workspaceId?: string
}> {
  public readonly code: WorkspaceChangePlanErrorCode
  public readonly kind: DomainErrorKind
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
    this.kind = workspaceChangePlanErrorKinds[opts.code]
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

function mapSubscriptionChangePlanError(
  error: SubscriptionChangePhasePlanError,
  context: {
    billingProjectId: string
    customerId: string
    targetPlanVersionId: string
    workspaceId: string
  }
): WorkspaceChangePlanError {
  switch (error.code) {
    case "SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED",
        message: scheduledPlanChangeUnavailableReason,
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_SAME_PLAN_VERSION":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT",
        message: "Workspace is already subscribed to this plan",
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_NOT_FOUND",
        message: notFoundTargetPlanMessage(),
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_INACTIVE":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_INACTIVE",
        message: error.message,
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_UNPUBLISHED":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_UNPUBLISHED",
        message: error.message,
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_ARCHIVED":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_ARCHIVED",
        message: error.message,
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_PROVIDER_UNAVAILABLE":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE",
        message: error.message,
        context,
      })
    case "SUBSCRIPTION_CHANGE_PLAN_NOT_FOUND":
    case "SUBSCRIPTION_CHANGE_PLAN_NOT_ACTIVE":
    case "SUBSCRIPTION_CHANGE_PLAN_ACTIVE_PHASE_NOT_FOUND":
      return new WorkspaceChangePlanError({
        code: "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
        message: "Workspace billing access not found",
        context,
      })
  }
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

  const subscriptionId = activePlan.subscriptionId

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
      if (isMissingPaymentMethodError(paymentMethodValidationResult.err)) {
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

  const currentCycleEndAt = activePlan.currentCycleEndAt
  const changeResult = await changeSubscriptionPhasePlan(
    {
      services: {
        billing: deps.services.billing,
        plans: deps.services.plans,
        subscriptions: deps.services.subscriptions,
      },
      db: deps.db,
      logger: deps.logger,
      now: deps.now,
    },
    {
      id: subscriptionId,
      projectId: billingProjectId,
      planVersionId: input.targetPlanVersionId,
      currentPlanVersionId: activePhase.planVersionId,
      currentCycleEndAt,
      timezone: activePlan.timezone,
      whenToChange: input.whenToChange,
      config: input.config,
      paymentMethodId: paymentMethodId ?? undefined,
      paymentMethodRequired: targetPlanVersion.paymentMethodRequired,
    }
  )

  if (changeResult.err) {
    if (changeResult.err instanceof SubscriptionChangePhasePlanError) {
      return Err(
        mapSubscriptionChangePlanError(changeResult.err, {
          workspaceId: rawInput.workspace.id,
          customerId,
          billingProjectId,
          targetPlanVersionId: input.targetPlanVersionId,
        })
      )
    }

    return Err(changeResult.err)
  }

  return Ok(
    workspaceChangePlanOutputSchema.parse(
      input.whenToChange === "immediately"
        ? {
            status: "changed",
            subscriptionId,
            phaseId: changeResult.val.phaseId,
          }
        : {
            status: "scheduled",
            subscriptionId,
            phaseId: changeResult.val.phaseId,
            effectiveAt: currentCycleEndAt,
          }
    )
  )
}
