import type { Database } from "@unprice/db"
import {
  type CreditLinePolicy,
  type PaymentProvider,
  type SubscriptionItemConfig,
  calculateDateAt,
  createDefaultSubscriptionConfig,
  getAnchor,
  getTrialIntervalForBillingInterval,
} from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { CustomerService } from "../customers/service"
import { toErrorContext } from "../utils/log-context"
import { UnPriceSubscriptionError } from "./errors"

export type ResolvePhaseSetupDeps = {
  db: Database
  customerService: Pick<CustomerService, "validatePaymentMethod">
  logger: Logger
}

export type ResolvePhaseSetupInput = {
  planVersionId: string
  projectId: string
  customerId: string
  startAt: number
  config?: SubscriptionItemConfig[]
  trialUnits?: number | null
  paymentProvider?: PaymentProvider | null
  creditLinePolicy?: CreditLinePolicy | null
  creditLineAmount?: number | null
  paymentMethodId?: string | null
}

/**
 * Shared preamble for materialising a subscription phase from a plan version:
 * fetch + validate the version, then derive the payment provider, credit-line
 * policy, trial window, billing anchor, payment method, and subscription item
 * config. Consumed verbatim by SubscriptionService.createPhase and
 * buildFuturePhaseUpdatePlan — the only parts that differ live after this seam
 * (billing-cycle calculation vs. replacement-item construction).
 */
export async function resolvePhaseSetup(
  deps: ResolvePhaseSetupDeps,
  input: ResolvePhaseSetupInput
) {
  const { db, customerService, logger } = deps
  const { planVersionId, projectId, customerId, startAt, config } = input

  const versionData = await db.query.versions.findFirst({
    with: {
      planFeatures: {
        with: {
          feature: true,
        },
      },
      plan: true,
      project: true,
    },
    where(fields, operators) {
      return operators.and(
        operators.eq(fields.id, planVersionId),
        operators.eq(fields.projectId, projectId)
      )
    },
  })

  if (!versionData?.id) {
    return Err(
      new UnPriceSubscriptionError({
        code: "PLAN_VERSION_NOT_FOUND",
        message: "Version not found. Please check the planVersionId",
      })
    )
  }

  if (versionData.status !== "published") {
    return Err(
      new UnPriceSubscriptionError({
        code: "PLAN_VERSION_NOT_PUBLISHED",
        message: "Plan version is not published, only published versions can be subscribed to",
      })
    )
  }

  if (versionData.active !== true) {
    return Err(
      new UnPriceSubscriptionError({
        code: "PLAN_VERSION_NOT_ACTIVE",
        message: "Plan version is not active, only active versions can be subscribed to",
      })
    )
  }

  if (!versionData.planFeatures || versionData.planFeatures.length === 0) {
    return Err(
      new UnPriceSubscriptionError({
        code: "PLAN_VERSION_FEATURES_MISSING",
        message: "Plan version has no features",
      })
    )
  }

  const paymentProviderToUse = input.paymentProvider ?? versionData.paymentProvider

  // Plans with included credits need the capped policy: uncapped phases never
  // open wallet reservations, so the granted credits would sit unused and
  // expire while usage is invoiced at full price.
  const includedCreditAmount = versionData.metadata?.includedCreditAmount ?? 0
  const creditLinePolicyToUse =
    input.creditLinePolicy ?? (includedCreditAmount > 0 ? "capped" : "uncapped")

  if (includedCreditAmount > 0 && creditLinePolicyToUse === "uncapped") {
    return Err(
      new UnPriceSubscriptionError({
        code: "CREDIT_POLICY_CONFLICT",
        message:
          "This plan includes credits, so the usage credit policy must be capped. Uncapped phases never spend wallet credits.",
      })
    )
  }

  const creditLineAmountToUse =
    creditLinePolicyToUse === "uncapped" ? null : (input.creditLineAmount ?? null)
  const trialUnitsToUse = input.trialUnits ?? versionData.trialUnits ?? 0
  const billingAnchorToUse = getAnchor(
    startAt,
    versionData.billingConfig.billingInterval,
    versionData.billingConfig.billingAnchor
  )
  const trialEndsAt =
    trialUnitsToUse > 0
      ? calculateDateAt({
          startDate: startAt,
          config: {
            interval: getTrialIntervalForBillingInterval(versionData.billingConfig.billingInterval),
            units: trialUnitsToUse,
          },
        })
      : null

  let paymentMethodIdToUse = input.paymentMethodId ?? null

  if (versionData.paymentMethodRequired && (!paymentMethodIdToUse || paymentMethodIdToUse === "")) {
    const { err: paymentMethodErr, val: paymentMethod } =
      await customerService.validatePaymentMethod({
        customerId,
        projectId,
        paymentProvider: paymentProviderToUse,
        requiredPaymentMethod: true,
      })

    if (paymentMethodErr) {
      return Err(
        new UnPriceSubscriptionError({
          code: "SUBSCRIPTION_OPERATION_FAILED",
          message: paymentMethodErr.message,
        })
      )
    }

    paymentMethodIdToUse = paymentMethod.paymentMethodId

    if (!paymentMethodIdToUse) {
      return Err(
        new UnPriceSubscriptionError({
          code: "PAYMENT_METHOD_REQUIRED",
          message: "Payment method is required for this plan version",
        })
      )
    }
  }

  let configItemsSubscription: SubscriptionItemConfig[]

  if (config) {
    configItemsSubscription = config
  } else {
    const defaultConfigResult = createDefaultSubscriptionConfig({
      planVersion: versionData,
    })

    if (defaultConfigResult.err) {
      logger.set({ error: toErrorContext(defaultConfigResult.err) })
      return Err(
        new UnPriceSubscriptionError({
          code: "SUBSCRIPTION_OPERATION_FAILED",
          message: defaultConfigResult.err.message,
        })
      )
    }

    configItemsSubscription = defaultConfigResult.val
  }

  return Ok({
    versionData,
    paymentProviderToUse,
    creditLinePolicyToUse,
    creditLineAmountToUse,
    trialUnitsToUse,
    billingAnchorToUse,
    trialEndsAt,
    paymentMethodIdToUse,
    configItemsSubscription,
  })
}
