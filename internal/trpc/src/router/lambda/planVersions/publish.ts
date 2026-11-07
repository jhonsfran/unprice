import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { publishPlanVersion } from "@unprice/services/use-cases"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"
import { paymentProviderPublishError } from "./publish-error"

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

    if (val.state === "invalid_reset_config") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Finite usage limits need a daily, weekly, monthly, or one-time reset. Set an explicit supported reset before publishing",
      })
    }

    if (val.state === "unpriced") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          val.reason === "no_card"
            ? "Assign a rate card in the version's currency before publishing"
            : `Price these features on the version's rate card before publishing: ${val.featureSlugs.join(", ")}`,
      })
    }

    if (val.state === "invalid_rows") {
      const byFeature = new Map<string, Set<string>>()
      for (const violation of val.violations) {
        byFeature.set(
          violation.feature,
          (byFeature.get(violation.feature) ?? new Set()).add(violation.code)
        )
      }
      const named = [...byFeature]
        .map(([feature, codes]) => `${feature} (${[...codes].join(", ")})`)
        .join("; ")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `The rate card's rows do not fit this version's features: ${named}`,
      })
    }

    if (val.state === "payment_provider_error") {
      throw paymentProviderPublishError()
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
