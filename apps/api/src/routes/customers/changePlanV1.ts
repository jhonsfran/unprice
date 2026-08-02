import { createRoute } from "@hono/zod-openapi"
import { creditLinePolicySchema, paymentProviderSchema } from "@unprice/db/validators"
import { fromCurrencyMinor, toLedgerMinor } from "@unprice/money"
import { isMissingPaymentMethodError } from "@unprice/services/payment-provider"
import {
  SubscriptionChangePhasePlanError,
  changeSubscriptionPhasePlan,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { resolveOwnedCustomer } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["customers"]

const changePlanRequestSchema = z
  .object({
    customerId: z.string().openapi({
      description: "The Unprice customer whose active subscription will change",
      example: "cus_1234567890",
    }),
    planVersionId: z.string().openapi({
      description: "The published target plan version",
      example: "pv_1234567890",
    }),
    creditLinePolicy: creditLinePolicySchema.optional().openapi({
      description:
        "Usage credit policy for the replacement phase. Required when creditLineAmountMinor is provided.",
      example: "capped",
    }),
    creditLineAmountMinor: z.coerce.number().int().min(0).safe().nullable().optional().openapi({
      description:
        "Optional replacement-phase credit cap in currency minor units. For USD/EUR, 1000 means $10.00.",
      example: 1_000,
    }),
  })
  .superRefine((data, ctx) => {
    if (
      data.creditLineAmountMinor !== null &&
      data.creditLineAmountMinor !== undefined &&
      data.creditLinePolicy !== "capped"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["creditLineAmountMinor"],
        message: "creditLineAmountMinor requires creditLinePolicy to be capped",
      })
    }
  })

const changePlanResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("changed"),
    subscriptionId: z.string(),
    phaseId: z.string(),
  }),
  z.object({
    status: z.literal("requires_payment_method"),
    paymentProvider: paymentProviderSchema,
    message: z.string(),
  }),
])

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/customers/change-plan",
      operationId: "customers.changePlan",
      summary: "change a customer's active plan",
      description:
        "Move a customer to a published plan version immediately. Returns the payment provider that must collect a payment method before the change when one is required. A capped replacement phase can receive an explicit wallet credit cap.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(changePlanRequestSchema, "The plan change request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(changePlanResponseSchema, "The plan change result"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "configuration",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["customers", "changePlan"],
      },
    }
  )
)

export const registerChangePlanV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customerId: requestedCustomerId,
      planVersionId,
      creditLineAmountMinor,
      creditLinePolicy,
    } = c.req.valid("json")
    const now = c.get("requestStartedAt")
    const { customerId, projectId, customer } = await resolveOwnedCustomer(c, {
      customerId: requestedCustomerId,
    })
    const { billing, customer: customers, plans, subscription } = c.get("services")

    const activeSubscriptionResult = await customers.getActiveSubscription({
      customerId,
      projectId,
      now,
      opts: { skipCache: true },
    })

    if (activeSubscriptionResult.err) {
      throw toUnpriceApiError(activeSubscriptionResult.err)
    }

    const activeSubscription = activeSubscriptionResult.val
    const activePhase = activeSubscription.activePhase

    if (!activePhase) {
      throw new UnpriceApiError({
        code: "PRECONDITION_FAILED",
        message: "Customer does not have an active subscription phase",
      })
    }

    const targetPlanVersionResult = await plans.getPlanVersionByIdRecord({
      planVersionId,
      projectId,
    })

    if (targetPlanVersionResult.err) {
      throw toUnpriceApiError(targetPlanVersionResult.err)
    }

    const targetPlanVersion = targetPlanVersionResult.val

    if (!targetPlanVersion) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Target plan version was not found",
      })
    }

    const includedCreditAmount = targetPlanVersion.metadata?.includedCreditAmount ?? 0
    const nextCreditLinePolicy =
      creditLinePolicy ?? (includedCreditAmount > 0 ? "capped" : "uncapped")
    const nextCreditLineAmount =
      nextCreditLinePolicy === "uncapped"
        ? null
        : creditLineAmountMinor === null || creditLineAmountMinor === undefined
          ? includedCreditAmount || null
          : toLedgerMinor(fromCurrencyMinor(creditLineAmountMinor, targetPlanVersion.currency))

    let paymentMethodId: string | undefined

    if (targetPlanVersion.paymentMethodRequired) {
      const paymentMethodResult = await customers.validatePaymentMethod({
        customerId,
        projectId,
        paymentProvider: targetPlanVersion.paymentProvider,
        requiredPaymentMethod: true,
      })

      if (paymentMethodResult.err) {
        if (isMissingPaymentMethodError(paymentMethodResult.err)) {
          return c.json(
            {
              status: "requires_payment_method" as const,
              paymentProvider: targetPlanVersion.paymentProvider,
              message: "Add a payment method before upgrading to this plan.",
            },
            HttpStatusCodes.OK
          )
        }

        throw toUnpriceApiError(paymentMethodResult.err)
      }

      paymentMethodId = paymentMethodResult.val.paymentMethodId ?? undefined
    }

    const changeResult = await changeSubscriptionPhasePlan(
      {
        services: { billing, plans, subscriptions: subscription },
        db: c.get("db"),
        logger: c.get("logger"),
        now: () => now,
      },
      {
        id: activeSubscription.id,
        projectId,
        planVersionId,
        currentPlanVersionId: activePhase.planVersionId,
        currentCycleEndAt: activeSubscription.currentCycleEndAt,
        timezone: activeSubscription.timezone,
        whenToChange: "immediately",
        paymentMethodId,
        paymentMethodRequired: targetPlanVersion.paymentMethodRequired,
        expectedCurrency: customer.defaultCurrency,
        creditLinePolicy: nextCreditLinePolicy,
        creditLineAmount: nextCreditLineAmount,
      },
      { targetPlanVersion }
    )

    if (changeResult.err) {
      if (changeResult.err instanceof SubscriptionChangePhasePlanError) {
        throw new UnpriceApiError({
          code:
            changeResult.err.code === "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND"
              ? "NOT_FOUND"
              : "PRECONDITION_FAILED",
          message: changeResult.err.message,
        })
      }

      throw toUnpriceApiError(changeResult.err)
    }

    return c.json(
      {
        status: "changed" as const,
        subscriptionId: activeSubscription.id,
        phaseId: changeResult.val.phaseId,
      },
      HttpStatusCodes.OK
    )
  })
