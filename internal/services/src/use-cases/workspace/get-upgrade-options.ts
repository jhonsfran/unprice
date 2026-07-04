import type { Database } from "@unprice/db"
import {
  getPlanVersionApiResponseSchema,
  paymentProviderSchema,
  type PaymentProvider,
  workspaceSelectBase,
} from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import {
  type GetCustomerCurrentAccessAnalytics,
  getCustomerCurrentAccess,
} from "../customer/get-current-access"
import { checkPaymentProviderAvailability } from "../payment-provider/availability"

const workspaceBillingContextSchema = workspaceSelectBase.pick({
  id: true,
  slug: true,
  unPriceCustomerId: true,
})

export const getWorkspaceUpgradeOptionsInputSchema = z.object({
  workspace: workspaceBillingContextSchema,
})

export const workspaceUpgradeOptionSchema = z.object({
  planVersion: getPlanVersionApiResponseSchema,
  isCurrent: z.boolean(),
  isAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  paymentProvider: paymentProviderSchema,
  paymentMethodRequired: z.boolean(),
  hasPaymentMethod: z.boolean(),
})

export const getWorkspaceUpgradeOptionsOutputSchema = z.object({
  customerId: z.string(),
  billingProjectId: z.string(),
  currentPlanVersionId: z.string().nullable(),
  currentSubscriptionId: z.string().nullable(),
  currentPhaseId: z.string().nullable(),
  currentCycleEndAt: z.number().nullable(),
  options: workspaceUpgradeOptionSchema.array(),
})

const getWorkspaceUpgradeOptionsErrorCodeSchema = z.enum([
  "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
  "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
  "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
  "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
])

type GetWorkspaceUpgradeOptionsErrorCode = z.infer<
  typeof getWorkspaceUpgradeOptionsErrorCodeSchema
>

export type GetWorkspaceUpgradeOptionsInput = z.infer<
  typeof getWorkspaceUpgradeOptionsInputSchema
>
export type WorkspaceUpgradeOption = z.infer<typeof workspaceUpgradeOptionSchema>
export type GetWorkspaceUpgradeOptionsOutput = z.infer<
  typeof getWorkspaceUpgradeOptionsOutputSchema
>

export class GetWorkspaceUpgradeOptionsError extends BaseError<{
  billingProjectId?: string
  customerId?: string
  workspaceId?: string
}> {
  public readonly code: GetWorkspaceUpgradeOptionsErrorCode
  public readonly retry = false
  public override readonly name = "GetWorkspaceUpgradeOptionsError"

  constructor(opts: {
    code: GetWorkspaceUpgradeOptionsErrorCode
    message: string
    context?: {
      billingProjectId?: string
      customerId?: string
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

type ProviderState = {
  hasPaymentMethod: boolean
  unavailableReason: string | null
}

const missingDefaultPaymentMethodMessages = new Set([
  "Required payment method not found",
  "Customer payment provider id not set",
  "No payment methods found",
])

export type GetWorkspaceUpgradeOptionsDeps = {
  services: Pick<ServiceContext, "customers" | "plans">
  db: Database
  analytics: GetCustomerCurrentAccessAnalytics
  logger: Logger
}

function paymentMethodRequiredReason(paymentProvider: PaymentProvider): string {
  switch (paymentProvider) {
    case "sandbox":
      return "Add a payment method before changing to this plan."
    case "square":
    case "stripe":
      return "Add a default payment method before changing to this plan."
  }
}

export function isMissingDefaultPaymentMethodError(error: unknown): boolean {
  return error instanceof Error && missingDefaultPaymentMethodMessages.has(error.message)
}

export async function getWorkspaceUpgradeOptions(
  deps: GetWorkspaceUpgradeOptionsDeps,
  rawInput: GetWorkspaceUpgradeOptionsInput
): Promise<
  Result<
    GetWorkspaceUpgradeOptionsOutput,
    GetWorkspaceUpgradeOptionsError | FetchError | UnPriceCustomerError
  >
> {
  const input = getWorkspaceUpgradeOptionsInputSchema.parse(rawInput)
  const customerId = input.workspace.unPriceCustomerId

  deps.logger.set({
    business: {
      operation: "workspace.get_upgrade_options",
      workspace_id: input.workspace.id,
      unprice_customer_id: customerId ?? undefined,
    },
  })

  if (!customerId) {
    return Err(
      new GetWorkspaceUpgradeOptionsError({
        code: "WORKSPACE_BILLING_CUSTOMER_ID_MISSING",
        message: "Workspace billing customer not found",
        context: {
          workspaceId: input.workspace.id,
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
      new GetWorkspaceUpgradeOptionsError({
        code: "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND",
        message: "Workspace billing customer not found",
        context: {
          workspaceId: input.workspace.id,
          customerId,
        },
      })
    )
  }

  const billingProjectId = customer.projectId
  const customerCurrency = customer.defaultCurrency ?? customer.project.defaultCurrency

  if (!customerCurrency) {
    return Err(
      new GetWorkspaceUpgradeOptionsError({
        code: "WORKSPACE_BILLING_CURRENCY_NOT_FOUND",
        message: "Workspace billing currency not found",
        context: {
          workspaceId: input.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  const [accessResult, planVersionsResult] = await Promise.all([
    getCustomerCurrentAccess(
      {
        db: deps.db,
        analytics: deps.analytics,
        logger: deps.logger,
      },
      {
        projectId: billingProjectId,
        customerId,
      }
    ),
    deps.services.plans.listPlanVersions({
      projectId: billingProjectId,
      query: {
        published: true,
      },
      opts: {
        skipCache: true,
      },
    }),
  ])

  if (accessResult.err) {
    return Err(accessResult.err)
  }

  if (!accessResult.val) {
    return Err(
      new GetWorkspaceUpgradeOptionsError({
        code: "WORKSPACE_BILLING_ACCESS_NOT_FOUND",
        message: "Workspace billing access not found",
        context: {
          workspaceId: input.workspace.id,
          customerId,
          billingProjectId,
        },
      })
    )
  }

  if (planVersionsResult.err) {
    return Err(planVersionsResult.err)
  }

  const activePlan = accessResult.val.activePlan
  const currentPlanVersionId = activePlan?.activePhase?.planVersionId ?? null

  const planVersions =
    planVersionsResult.val?.filter(
      (planVersion) =>
        planVersion.active && planVersion.status === "published" && planVersion.currency === customerCurrency
    ) ?? []

  const providerStates = new Map<PaymentProvider, ProviderState>()

  for (const paymentProvider of new Set(planVersions.map((planVersion) => planVersion.paymentProvider))) {
    const availabilityResult = await checkPaymentProviderAvailability(deps, {
      projectId: billingProjectId,
      paymentProvider,
    })

    if (availabilityResult.err) {
      return Err(availabilityResult.err)
    }

    if (!availabilityResult.val.available) {
      providerStates.set(paymentProvider, {
        hasPaymentMethod: false,
        unavailableReason: availabilityResult.val.message,
      })
      continue
    }

    const paymentMethodValidationResult = await deps.services.customers.validatePaymentMethod({
      customerId,
      projectId: billingProjectId,
      paymentProvider,
      requiredPaymentMethod: true,
    })

    if (paymentMethodValidationResult.err) {
      if (isMissingDefaultPaymentMethodError(paymentMethodValidationResult.err)) {
        providerStates.set(paymentProvider, {
          hasPaymentMethod: false,
          unavailableReason: null,
        })
        continue
      }

      return Err(paymentMethodValidationResult.err)
    }

    providerStates.set(paymentProvider, {
      hasPaymentMethod: paymentMethodValidationResult.val.paymentMethodId !== null,
      unavailableReason: null,
    })
  }

  const output = getWorkspaceUpgradeOptionsOutputSchema.parse({
    customerId,
    billingProjectId,
    currentPlanVersionId,
    currentSubscriptionId: activePlan?.subscriptionId ?? null,
    currentPhaseId: activePlan?.activePhase?.id ?? null,
    currentCycleEndAt: activePlan?.currentCycleEndAt ?? null,
    options: planVersions.map((planVersion) => {
      const providerState = providerStates.get(planVersion.paymentProvider) ?? {
        hasPaymentMethod: false,
        unavailableReason: "Payment provider status unavailable.",
      }
      const isCurrent = planVersion.id === currentPlanVersionId
      const paymentMethodRequired = planVersion.paymentMethodRequired
      const missingPaymentMethod = paymentMethodRequired && !providerState.hasPaymentMethod

      const unavailableReason = isCurrent
        ? "This is your current plan."
        : providerState.unavailableReason
          ? providerState.unavailableReason
          : missingPaymentMethod
            ? paymentMethodRequiredReason(planVersion.paymentProvider)
            : null

      return {
        planVersion,
        isCurrent,
        isAvailable: unavailableReason === null,
        unavailableReason,
        paymentProvider: planVersion.paymentProvider,
        paymentMethodRequired,
        hasPaymentMethod: providerState.hasPaymentMethod,
      }
    }),
  })

  return Ok(output)
}
