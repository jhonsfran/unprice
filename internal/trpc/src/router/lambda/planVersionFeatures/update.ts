import { TRPCError } from "@trpc/server"
import { z } from "zod"

import {
  planVersionFeatureDragDropSchema,
  planVersionFeatureUpdateBaseSchema,
} from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(planVersionFeatureUpdateBaseSchema)
  .output(
    z.object({
      planVersionFeature: planVersionFeatureDragDropSchema,
    })
  )
  .mutation(async (opts) => {
    const hasMeterConfigOverride = Object.prototype.hasOwnProperty.call(opts.input, "meterConfig")
    const {
      id,
      featureId,
      featureType,
      config,
      metadata,
      planVersionId,
      order,
      defaultQuantity,
      limit,
      billingConfig,
      resetConfig,
      type,
      unitOfMeasure,
      meterConfig,
    } = opts.input

    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    // only owner and admin can update a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.updatePlanVersionFeatureRecord({
      projectId: project.id,
      id,
      featureId,
      featureType,
      config,
      metadata,
      planVersionId,
      order,
      defaultQuantity,
      limit,
      billingConfig,
      resetConfig,
      type,
      unitOfMeasure,
      meterConfig,
      hasMeterConfigOverride,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

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
        message: "Invalid reset configuration: invalid reset anchor",
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
    }
  })
