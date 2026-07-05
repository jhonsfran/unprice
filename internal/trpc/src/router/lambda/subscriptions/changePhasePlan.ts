import { TRPCError } from "@trpc/server"
import { subscriptionChangePlanSchema } from "@unprice/db/validators"
import {
  SubscriptionChangePhasePlanError,
  changeSubscriptionPhasePlan,
  subscriptionChangePhasePlanOutputSchema,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"
import {
  isExpectedBillingPreconditionError,
  isExpectedSubscriptionPreconditionError,
} from "./updatePhase-errors"

export const changePhasePlan = protectedProjectProcedure
  .input(subscriptionChangePlanSchema)
  .output(subscriptionChangePhasePlanOutputSchema)
  .mutation(async (opts) => {
    // only owner and admin can schedule a phase change
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await changeSubscriptionPhasePlan(
      {
        services: {
          billing: opts.ctx.services.billing,
          plans: opts.ctx.services.plans,
          subscriptions: opts.ctx.services.subscriptions,
        },
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        ...opts.input,
        projectId: opts.ctx.project.id,
      }
    )

    if (result.err) {
      throw changePhasePlanErrorToTrpcError(result.err)
    }

    return result.val
  })

function changePhasePlanErrorToTrpcError(error: unknown): TRPCError {
  if (error instanceof SubscriptionChangePhasePlanError) {
    switch (error.code) {
      case "SUBSCRIPTION_CHANGE_PLAN_NOT_FOUND":
      case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_NOT_FOUND":
        return new TRPCError({ code: "BAD_REQUEST", message: error.message })
      case "SUBSCRIPTION_CHANGE_PLAN_NOT_ACTIVE":
      case "SUBSCRIPTION_CHANGE_PLAN_ACTIVE_PHASE_NOT_FOUND":
      case "SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED":
      case "SUBSCRIPTION_CHANGE_PLAN_SAME_PLAN_VERSION":
      case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_INACTIVE":
      case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_UNPUBLISHED":
      case "SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_ARCHIVED":
      case "SUBSCRIPTION_CHANGE_PLAN_PROVIDER_UNAVAILABLE":
        return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
    }
  }

  if (error instanceof Error && error.name === "SchemaError") {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message })
  }

  if (isExpectedSubscriptionPreconditionError(error)) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
  }

  if (isExpectedBillingPreconditionError(error)) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Failed to schedule subscription phase",
  })
}
