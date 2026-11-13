import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planVersionFeatureSelectBaseSchema } from "@unprice/db/validators"
import { removePlanVersionFeature } from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Detaches a feature from a draft version and ends its rows on the version's own card. */
export const remove = protectedProjectProcedure
  .input(
    planVersionFeatureSelectBaseSchema
      .pick({
        id: true,
      })
      .required({ id: true })
  )
  .output(z.object({ plan: planVersionFeatureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { plans, rateCards } = opts.ctx.services

    // only owner and admin can delete a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await removePlanVersionFeature(
      { db: opts.ctx.db, services: { plans, rateCards } },
      { projectId: project.id, id, now: Date.now() }
    )

    if (err) throw domainErrorToTrpcError(err)

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature version not found",
      })
    }

    if (val.state === "published_conflict") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot delete a feature from a published version",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting feature",
      })
    }

    return {
      plan: val.planVersionFeature,
    }
  })
