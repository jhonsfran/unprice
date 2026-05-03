import { TRPCError } from "@trpc/server"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { duplicatePlanVersion } from "@unprice/services/use-cases"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

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

    // only owner and admin can duplicate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await duplicatePlanVersion(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        id,
        projectId: project.id,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

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
