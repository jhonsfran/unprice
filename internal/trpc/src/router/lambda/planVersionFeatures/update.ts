import { TRPCError } from "@trpc/server"

import { planVersionFeatureUpdateBaseSchema } from "@unprice/db/validators"
import { updatePlanVersionFeature } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/**
 * Edits a draft version's feature and, when `price` is given, prices it on the version's own
 * rate card in the same step; `price: null` leaves it unpriced. Answers the feature and its open
 * default row.
 */
export const update = protectedProjectProcedure
  .input(planVersionFeatureUpdateBaseSchema)
  .mutation(async (opts) => {
    const project = opts.ctx.project
    const { plans, features, rateCards } = opts.ctx.services

    // only owner and admin can update a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await updatePlanVersionFeature(
      { services: { plans, features, rateCards }, logger: opts.ctx.logger },
      { ...opts.input, projectId: project.id, now: Date.now() }
    )

    if (err) throw domainErrorToTrpcError(err)

    if (val.state === "plan_version_feature_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature version not found",
      })
    }

    if (val.state === "plan_version_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version of the plan not found",
      })
    }

    if (val.state === "plan_version_published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot update a feature from a published version",
      })
    }

    if (val.state === "usage_meter_config_required") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Usage features require meterConfig or a default feature meterConfig",
      })
    }

    if (val.state === "invalid_reset_config") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Reset cadence must be equal to or shorter than feature billing",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating version",
      })
    }

    return {
      planVersionFeature: val.planVersionFeature,
      row: val.row,
    }
  })
