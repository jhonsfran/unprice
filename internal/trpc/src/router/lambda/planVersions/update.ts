import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(planVersionSelectBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      status,
      id,
      description,
      currency,
      billingConfig,
      gracePeriod,
      title,
      tags,
      whenToBill,
      paymentProvider,
      metadata,
      autoRenew,
      trialUnits,
      collectionMethod,
      dueBehaviour,
      paymentMethodRequired,
    } = opts.input

    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    // only owner and admin can update a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.updatePlanVersionRecord({
      projectId: project.id,
      id,
      status,
      description,
      currency,
      billingConfig,
      gracePeriod,
      title,
      tags,
      whenToBill,
      paymentProvider,
      metadata,
      autoRenew,
      trialUnits,
      collectionMethod,
      dueBehaviour,
      paymentMethodRequired,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version not found",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
