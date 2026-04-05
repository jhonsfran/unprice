import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { publishPlanVersion } from "@unprice/services/use-cases"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"

export const publish = protectedProjectProcedure
  .input(planVersionSelectBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id } = opts.input

    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace

    // only owner and admin can publish a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await publishPlanVersion(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        userId: opts.ctx.userId,
      },
      {
        id,
        projectId: project.id,
        workspaceUnPriceCustomerId: workspace.unPriceCustomerId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "version_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version not found",
      })
    }

    if (val.state === "already_published") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Version already published",
      })
    }

    if (val.state === "no_features") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot publish a version without features",
      })
    }

    if (val.state === "price_calculation_error") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error calculating price plan",
      })
    }

    if (val.state === "payment_provider_error") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error validating payment provider",
      })
    }

    if (val.state === "publish_error") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "error publishing version",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "error publishing version",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
