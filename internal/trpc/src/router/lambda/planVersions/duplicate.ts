import { TRPCError } from "@trpc/server"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { duplicatePlanVersion } from "@unprice/services/use-cases"
import { z } from "zod"

import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

/** Copies a version as a draft, with its own card holding the source's prices in force. */
export const duplicate = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const { rateCards } = opts.ctx.services

    // only owner and admin can duplicate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await duplicatePlanVersion(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        services: { rateCards },
      },
      {
        id,
        projectId: project.id,
      }
    )

    if (err) throw domainErrorToTrpcError(err)

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    if (val.state === "duplicate_error") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error duplicating version",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error duplicating version",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
